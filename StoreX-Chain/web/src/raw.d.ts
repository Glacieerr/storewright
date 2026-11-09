/** Vite 的 `?raw` 导入：文件原文（值班助手的资料库用设计文档的原文） */
declare module '*.md?raw' {
  const text: string;
  export default text;
}
