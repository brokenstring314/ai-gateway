/** Text imports (`import css from "./x.css" with { type: "text" }`), embedded by Bun at build time. */
declare module "*.css" {
  const text: string;
  export default text;
}
