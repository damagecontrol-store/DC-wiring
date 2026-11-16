// Damage Control fonts and logo, bundled as data URLs (esbuild "dataurl" loader) so exported reports carry them.
import logo from "./dc-logo.png";
import exo from "./exo-2-latin-wght-normal.woff2";
import plex400 from "./ibm-plex-sans-condensed-latin-400-normal.woff2";
import plex600 from "./ibm-plex-sans-condensed-latin-600-normal.woff2";
import oxanium from "./oxanium-latin-wght-normal.woff2";

const face = (family: string, src: string, weight: string) =>
	`@font-face { font-family: "${family}"; src: url(${src}) format("woff2"); font-weight: ${weight}; }`;

export const BRAND = {
	logo,
	fontCss: [face("Oxanium", oxanium, "200 800"), face("Exo 2", exo, "100 900"),
		face("IBM Plex Sans Condensed", plex400, "400"), face("IBM Plex Sans Condensed", plex600, "600")].join("\n"),
};
