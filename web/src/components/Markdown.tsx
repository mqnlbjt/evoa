import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

/** 安全的 Markdown → HTML 渲染。 */
export function Markdown({ text }: { text: string }): React.ReactElement {
	const html = useMemo(() => {
		const raw = marked.parse(text, { async: false, breaks: true }) as string;
		return DOMPurify.sanitize(raw);
	}, [text]);
	return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 工具调用/结果原始数据的 JSON 展示（截断长内容）。 */
export function JsonBlock({ value, maxChars = 4000 }: { value: unknown; maxChars?: number }): React.ReactElement | null {
	if (value === undefined || value === null) return null;
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (truncated ${text.length - maxChars} chars)`;
	return (
		<pre className="json-block">
			<code>{text}</code>
		</pre>
	);
}
