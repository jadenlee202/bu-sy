// Static mode deliberately probes for an API; version.json exists only in a
// deployment. Permit only these two expected 404s, never missing CSS/JS/data.
function optionalLocal404(url, message) {
  const path = new URL(url || "http://localhost").pathname;
  return /404/.test(message) && (path === "/api/facilities" || path === "/version.json");
}

export function browserErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    if (!optionalLocal404(url, message.text())) errors.push(`${url}: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !optionalLocal404(response.url(), String(response.status()))) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  return errors;
}
