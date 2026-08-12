import { useMemo } from "react";
import type { ReactElement } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

/** 安全的 Markdown → HTML 渲染（类名 .markdown，样式由 styles.css 负责）。 */
export function Markdown({ text }: { text: string }): ReactElement {
	const html = useMemo(() => {
		const raw = marked.parse(text, { async: false, breaks: true }) as string;
		return DOMPurify.sanitize(raw);
	}, [text]);
	return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 工具调用/原始数据的 JSON 展示（类名 .json-block，样式由 styles.css 负责）。
 * 长内容截断：字符串原样展示（patch 等不套 JSON 引号），对象/数组格式化后截断。
 */
export function JsonBlock({ value, maxChars = 4000 }: { value: unknown; maxChars?: number }): ReactElement | null {
	if (value === undefined || value === null) return null;

	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
	}

	if (text.length > maxChars) {
		const remaining = text.length - maxChars;
		text = `${text.slice(0, maxChars)}\n… (truncated ${remaining} chars)`;
	}

	return (
		<pre className="json-block">
			<code>{text}</code>
		</pre>
	);
}
