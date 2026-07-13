// Markdown renderer for chat messages: GitHub-flavored markdown + syntax
// highlighting, with a copy button on every fenced code block. Memoized so
// streaming updates only re-render when the text actually changes.
import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  function copy() {
    const text = (ref.current?.textContent ?? "").replace(/\n$/, "");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }
  return (
    <div className="code-wrap">
      <button className="code-copy" onClick={copy} title="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
export default Markdown;
