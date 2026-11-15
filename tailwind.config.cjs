// Tailwind is compiled to `public/tailwind.css` at build time so the browser
// gets a small stylesheet instead of the ~400 KB runtime JIT compiler from
// `cdn.tailwindcss.com` (which was also render-blocking).
//
// The class names live in the HTML shell and in the ES modules under
// `public/app`, so both are scanned. Run `npm run build:css` after adding a new
// Tailwind class anywhere in those files.
module.exports = {
  darkMode: "class",
  content: ["./public/index.html", "./public/app/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif"
        ]
      }
    }
  }
};
