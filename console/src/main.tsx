import { render } from "preact";
import { App } from "./app";
import { lang } from "./i18n";
import "./styles.css";

document.documentElement.lang = lang() === "zh" ? "zh-CN" : "en";
const root = document.getElementById("app");
if (root) render(<App />, root);
