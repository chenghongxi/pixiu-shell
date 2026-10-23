const fs = require("fs");
const path = require("path");

function update(file, transform) {
  const full = path.resolve(file);
  const before = fs.readFileSync(full, "utf8");
  const after = transform(before);
  if (after === before) {
    throw new Error("No change in " + file);
  }
  fs.writeFileSync(full, after);
  console.log("updated", file);
}

update("src/index.css", (s) => {
  const light = `:root {
  font-family: "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  --background: #f4f5f7;
  --foreground: #24272e;
  --card: #ffffff;
  --card-foreground: #24272e;
  --popover: #ffffff;
  --popover-foreground: #24272e;
  --primary: #335ed6;
  --primary-foreground: #ffffff;
  --secondary: #e8ebef;
  --secondary-foreground: #586273;
  --muted: #eceef2;
  --muted-foreground: #727b8b;
  --accent: #eaf0fc;
  --accent-foreground: #335ed6;
  --destructive: #c34750;
  --border: #dce4ee;
  --input: #e9ecf1;
  --ring: #6688dd;
  --radius: 0.4rem;
  --rail: #e7e9ed;
  --sidebar: #eceef2;
  --toolbar: #e7e9ed;
  --surface: #f0f1f4;
  --active: #dce1e9;
  --hover: #e3e6ec;
  --terminal-meta: #e9ecf1;
  --green: #33805a;
  --status: #e7e9ed;
  --shadow: 0 8px 30px #15274312;
  --tone-teal: #087f83;
  --tone-amber: #a7680b;
  --tone-violet: #7952c3;
  color-scheme: light;
}`;
  const lightNew = `:root {
  font-family: "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  /* Surfaces mix with the desktop; text, icons and borders stay opaque. */
  --window-opacity: 100%;
  --background-solid: #f4f5f7;
  --background: color-mix(
    in srgb,
    var(--background-solid) var(--window-opacity),
    transparent
  );
  --foreground: #24272e;
  --card-solid: #ffffff;
  --card: color-mix(in srgb, var(--card-solid) var(--window-opacity), transparent);
  --card-foreground: #24272e;
  --popover-solid: #ffffff;
  --popover: color-mix(
    in srgb,
    var(--popover-solid) var(--window-opacity),
    transparent
  );
  --popover-foreground: #24272e;
  --primary: #335ed6;
  --primary-foreground: #ffffff;
  --secondary: color-mix(in srgb, #e8ebef var(--window-opacity), transparent);
  --secondary-foreground: #586273;
  --muted: color-mix(in srgb, #eceef2 var(--window-opacity), transparent);
  --muted-foreground: #727b8b;
  --accent: color-mix(in srgb, #eaf0fc var(--window-opacity), transparent);
  --accent-foreground: #335ed6;
  --destructive: #c34750;
  --border: #dce4ee;
  --input: color-mix(in srgb, #e9ecf1 var(--window-opacity), transparent);
  --ring: #6688dd;
  --radius: 0.4rem;
  --rail: color-mix(in srgb, #e7e9ed var(--window-opacity), transparent);
  --sidebar: color-mix(in srgb, #eceef2 var(--window-opacity), transparent);
  --toolbar: color-mix(in srgb, #e7e9ed var(--window-opacity), transparent);
  --surface: color-mix(in srgb, #f0f1f4 var(--window-opacity), transparent);
  --active: color-mix(in srgb, #dce1e9 var(--window-opacity), transparent);
  --hover: color-mix(in srgb, #e3e6ec var(--window-opacity), transparent);
  --terminal-meta: color-mix(in srgb, #e9ecf1 var(--window-opacity), transparent);
  --green: #33805a;
  --status: color-mix(in srgb, #e7e9ed var(--window-opacity), transparent);
  --shadow: 0 8px 30px #15274312;
  --tone-teal: #087f83;
  --tone-amber: #a7680b;
  --tone-violet: #7952c3;
  color-scheme: light;
}`;
  if (!s.includes(light)) throw new Error("light :root block not found");
  s = s.replace(light, lightNew);

  const dark = `:root.dark {
  --background: var(--graphite-background, #1b1b1b);
  --foreground: #d8dce5;
  --card: #242424;
  --card-foreground: #d8dce5;
  --popover: #292929;
  --popover-foreground: #d8dce5;
  --primary: #7b9cf5;
  --primary-foreground: #101828;
  --secondary: #303030;
  --secondary-foreground: #b9bbc1;
  --muted: #242424;
  --muted-foreground: #999ba3;
  --accent: #303030;
  --accent-foreground: #a7bfff;
  --destructive: #ed8187;
  --border: #303030;
  --input: #2e2e2e;
  --ring: #7897e9;
  --rail: #181818;
  --sidebar: #202020;
  --toolbar: #181818;
  --surface: #282828;
  --active: #353535;
  --hover: #2d2d2d;
  --terminal-meta: #242424;
  --green: #86bd9c;
  --status: #181818;
  --shadow: 0 8px 30px #0004;
  --tone-teal: #58cbbb;
  --tone-amber: #e4b568;
  --tone-violet: #b5a0ee;
  color-scheme: dark;
}`;
  const darkNew = `:root.dark {
  --background-solid: var(--graphite-background, #1b1b1b);
  --background: color-mix(
    in srgb,
    var(--background-solid) var(--window-opacity),
    transparent
  );
  --foreground: #d8dce5;
  --card-solid: #242424;
  --card: color-mix(in srgb, var(--card-solid) var(--window-opacity), transparent);
  --card-foreground: #d8dce5;
  --popover-solid: #292929;
  --popover: color-mix(
    in srgb,
    var(--popover-solid) var(--window-opacity),
    transparent
  );
  --popover-foreground: #d8dce5;
  --primary: #7b9cf5;
  --primary-foreground: #101828;
  --secondary: color-mix(in srgb, #303030 var(--window-opacity), transparent);
  --secondary-foreground: #b9bbc1;
  --muted: color-mix(in srgb, #242424 var(--window-opacity), transparent);
  --muted-foreground: #999ba3;
  --accent: color-mix(in srgb, #303030 var(--window-opacity), transparent);
  --accent-foreground: #a7bfff;
  --destructive: #ed8187;
  --border: #303030;
  --input: color-mix(in srgb, #2e2e2e var(--window-opacity), transparent);
  --ring: #7897e9;
  --rail: color-mix(in srgb, #181818 var(--window-opacity), transparent);
  --sidebar: color-mix(in srgb, #202020 var(--window-opacity), transparent);
  --toolbar: color-mix(in srgb, #181818 var(--window-opacity), transparent);
  --surface: color-mix(in srgb, #282828 var(--window-opacity), transparent);
  --active: color-mix(in srgb, #353535 var(--window-opacity), transparent);
  --hover: color-mix(in srgb, #2d2d2d var(--window-opacity), transparent);
  --terminal-meta: color-mix(in srgb, #242424 var(--window-opacity), transparent);
  --green: #86bd9c;
  --status: color-mix(in srgb, #181818 var(--window-opacity), transparent);
  --shadow: 0 8px 30px #0004;
  --tone-teal: #58cbbb;
  --tone-amber: #e4b568;
  --tone-violet: #b5a0ee;
  color-scheme: dark;
}`;
  if (!s.includes(dark)) throw new Error("dark :root block not found");
  s = s.replace(dark, darkNew);
  return s;
});
console.log("theme vars ok");
