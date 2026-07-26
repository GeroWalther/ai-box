// Path guarding for every agent filesystem tool — desktop AND remote.
//
// Previously only network callers were jailed: a phone couldn't read ~/.ssh, but
// the agent running in the desktop window could write anywhere the user could,
// with no approval and no confinement. Since tool arguments come from model
// output — and model output can be steered by a web page the agent fetched — that
// meant a prompt injection could rewrite ~/.zshrc or drop a LaunchAgent. Both
// callers now go through the same two checks:
//
//   1. CONFINEMENT — the path must resolve inside the configured workspace root,
//      with `..` and symlink escapes rejected. Configurable; defaults to $HOME.
//   2. PROTECTED PATHS — credentials, shell startup files, launch agents and the
//      app's own store are refused outright. This check is deliberately NOT
//      bypassable by the auto-approve setting: "don't interrupt me" should mean
//      fewer prompts, never "you may rewrite my SSH keys unattended".
//
// Shell commands cannot be confined this way (a shell can do anything), so those
// stay gated by the approval prompt instead — see `require_approval`.

use std::path::{Component, Path, PathBuf};

/// Resolved guard configuration for one call.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Absolute directory the agent is confined to.
    pub root: PathBuf,
    /// Escape hatch for users who really do want the agent editing dotfiles.
    pub allow_protected: bool,
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Expand a leading `~` and return an absolute path.
pub fn expand(raw: &str) -> PathBuf {
    let h = home();
    let s = if raw == "~" {
        h
    } else if let Some(rest) = raw.strip_prefix("~/") {
        format!("{h}/{rest}")
    } else {
        raw.to_string()
    };
    PathBuf::from(s)
}

impl Policy {
    /// Build a policy from the settings blob the frontend pushes.
    ///
    /// `agentWorkspace` is the current field; `remoteWorkspace` is read as a
    /// fallback so an older stored settings blob keeps working. An unset or blank
    /// value means the user's home directory.
    pub fn from_settings(v: &serde_json::Value) -> Self {
        let pick = |key: &str| {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let raw = pick("agentWorkspace")
            .or_else(|| pick("remoteWorkspace"))
            .unwrap_or_else(home);
        let root = expand(&raw);
        Policy {
            root: root.canonicalize().unwrap_or(root),
            allow_protected: v
                .get("allowProtectedPaths")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
        }
    }

    /// A policy rooted at the user's home with protected paths enforced — the
    /// default when no settings have been pushed yet.
    pub fn default_home() -> Self {
        let root = PathBuf::from(home());
        Policy {
            root: root.canonicalize().unwrap_or(root),
            allow_protected: false,
        }
    }
}

/// Path segments that are never readable or writable by an agent tool.
/// Matched case-insensitively, because macOS filesystems are case-insensitive by
/// default and `~/.SSH/id_rsa` is the same file as `~/.ssh/id_rsa`.
const PROTECTED_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gh",
    ".password-store",
    ".ai-studio", // the app's own store, backups and dev secrets
    "library/keychains",
    "library/launchagents",
    "library/launchdaemons",
    "library/cookies",
];

/// Individual files that are never readable or writable: credential stores and
/// shell startup files (the classic persistence foothold).
const PROTECTED_FILES: &[&str] = &[
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".zlogout",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
];

/// System locations that stay off-limits regardless of the configured root.
const PROTECTED_PREFIXES: &[&str] = &["/etc", "/system", "/private/etc", "/var/db", "/library/launchdaemons"];

/// Does this path touch something the agent must never read or write?
pub fn is_protected(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_lowercase();
    let lower = lower.trim_end_matches('/').to_string();

    if PROTECTED_PREFIXES
        .iter()
        .any(|p| lower == *p || lower.starts_with(&format!("{p}/")))
    {
        return true;
    }

    // Any *directory* segment match blocks the whole subtree, so ~/.ssh/foo/bar
    // is refused as well as ~/.ssh itself.
    for dir in PROTECTED_DIRS {
        let needle = format!("/{dir}");
        if lower.ends_with(&needle) || lower.contains(&format!("{needle}/")) {
            return true;
        }
    }

    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let name = name.to_lowercase();
        if PROTECTED_FILES.iter().any(|f| *f == name) {
            return true;
        }
    }
    false
}

/// Nearest ancestor of `p` that exists, so a path that doesn't exist yet (a file
/// about to be created) can still be canonicalized for the escape check.
fn nearest_existing(p: &Path) -> PathBuf {
    let mut cur = p;
    loop {
        if cur.exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(parent) => cur = parent,
            None => return PathBuf::from("/"),
        }
    }
}

/// Resolve an agent-supplied path under `policy`, or explain the refusal.
///
/// Relative paths resolve against the root. `..` is rejected outright, and the
/// result is canonicalized so a symlink pointing out of the workspace can't be
/// used to escape it.
pub fn confine(policy: &Policy, path: &str) -> Result<String, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("no path given".into());
    }

    // `~` is ambiguous once a workspace root is in play; require a real path.
    let candidate = if raw == "~" || raw.starts_with("~/") {
        expand(raw)
    } else {
        PathBuf::from(raw)
    };

    let joined = if candidate.is_absolute() {
        candidate
    } else {
        policy.root.join(candidate)
    };

    if joined.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("paths can't contain '..'".into());
    }

    // Canonicalize the deepest part that exists (resolving any symlinks), then
    // re-attach the not-yet-existing tail. Both halves matter: canonicalizing is
    // what defeats a symlink escape, and keeping the tail is what lets the
    // protected check see the real target name — a `.zshrc` that is about to be
    // created has no `nearest_existing` of its own.
    let existing = nearest_existing(&joined);
    let anchor = existing
        .canonicalize()
        .map_err(|e| format!("bad path: {e}"))?;
    let tail = joined.strip_prefix(&existing).unwrap_or(Path::new(""));
    let resolved = if tail.as_os_str().is_empty() {
        anchor
    } else {
        anchor.join(tail)
    };

    if !resolved.starts_with(&policy.root) {
        return Err(format!(
            "path is outside the agent workspace ({})",
            policy.root.display()
        ));
    }

    if !policy.allow_protected && is_protected(&resolved) {
        return Err(format!(
            "'{}' is a protected location (credentials, shell startup files and launch agents \
             are off-limits to the agent). Enable \"Allow protected paths\" in Settings → Agent \
             if you really need this.",
            resolved.display()
        ));
    }

    Ok(resolved.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_at(root: &str) -> Policy {
        let p = PathBuf::from(root);
        Policy {
            root: p.canonicalize().unwrap_or(p),
            allow_protected: false,
        }
    }

    #[test]
    fn protected_paths_are_recognized() {
        assert!(is_protected(Path::new("/Users/x/.ssh")));
        assert!(is_protected(Path::new("/Users/x/.ssh/id_rsa")));
        assert!(is_protected(Path::new("/Users/x/.aws/credentials")));
        assert!(is_protected(Path::new("/Users/x/.zshrc")));
        assert!(is_protected(Path::new("/Users/x/Library/LaunchAgents/evil.plist")));
        assert!(is_protected(Path::new("/etc/hosts")));
        assert!(is_protected(Path::new("/Users/x/.ai-studio/store.json")));
        // Case-insensitive: macOS treats these as the same file.
        assert!(is_protected(Path::new("/Users/x/.SSH/id_rsa")));
        assert!(is_protected(Path::new("/Users/x/.ZshRc")));
        // Ordinary project files are fine.
        assert!(!is_protected(Path::new("/Users/x/code/app/src/main.rs")));
        assert!(!is_protected(Path::new("/Users/x/Documents/novel.md")));
        // A file that merely mentions a protected name is not protected.
        assert!(!is_protected(Path::new("/Users/x/code/ssh-notes.md")));
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let p = policy_at("/tmp");
        assert!(confine(&p, "../etc/passwd").is_err());
        assert!(confine(&p, "/tmp/../etc/passwd").is_err());
    }

    #[test]
    fn paths_outside_the_root_are_rejected() {
        let p = policy_at("/tmp");
        let err = confine(&p, "/usr/local/bin/thing").unwrap_err();
        assert!(err.contains("outside the agent workspace"), "{err}");
    }

    #[test]
    fn protected_paths_are_refused_even_inside_the_root() {
        let home = home();
        let p = policy_at(&home);
        let err = confine(&p, &format!("{home}/.ssh/authorized_keys")).unwrap_err();
        assert!(err.contains("protected location"), "{err}");
    }

    #[test]
    fn allow_protected_opt_out_works() {
        let home = home();
        let mut p = policy_at(&home);
        p.allow_protected = true;
        assert!(confine(&p, &format!("{home}/.zshrc")).is_ok());
    }

    #[test]
    fn ordinary_paths_resolve() {
        let p = policy_at("/tmp");
        let got = confine(&p, "/tmp/some-file.txt").unwrap();
        // /tmp is a symlink to /private/tmp on macOS; the canonical form is fine
        // so long as it still sits under the (equally canonicalized) root AND
        // keeps the filename — dropping the tail would silently retarget writes
        // at the parent directory.
        assert!(got.ends_with("some-file.txt"), "{got}");
    }

    #[test]
    fn a_file_that_does_not_exist_yet_is_still_checked() {
        // The protected check must see through to a name that has no inode yet,
        // otherwise "create ~/.zshrc" would slip past it.
        let home = home();
        let p = policy_at(&home);
        let err = confine(&p, &format!("{home}/.zshrc")).unwrap_err();
        assert!(err.contains("protected location"), "{err}");
    }

    #[test]
    fn relative_paths_resolve_against_the_root() {
        let p = policy_at("/tmp");
        let got = confine(&p, "nested/file.txt").unwrap();
        assert!(got.ends_with("nested/file.txt"), "{got}");
    }

    #[test]
    fn policy_reads_settings_fields() {
        let v = serde_json::json!({ "agentWorkspace": "/tmp", "allowProtectedPaths": true });
        let p = Policy::from_settings(&v);
        assert!(p.allow_protected);
        assert!(p.root.ends_with("tmp"));
        // Legacy field still honoured.
        let legacy = serde_json::json!({ "remoteWorkspace": "/tmp" });
        assert!(Policy::from_settings(&legacy).root.ends_with("tmp"));
        // Nothing configured → home, protections on.
        let empty = serde_json::json!({});
        let d = Policy::from_settings(&empty);
        assert!(!d.allow_protected);
        assert_eq!(d.root, PathBuf::from(home()).canonicalize().unwrap_or(PathBuf::from(home())));
    }
}
