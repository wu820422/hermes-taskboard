export async function fetchApplicationAsset(request, assets) {
  const response = await assets.fetch(request);
  if (response.status !== 404 || !["GET", "HEAD"].includes(request.method)) {
    return response;
  }

  // Sites may expose the archived dist tree at different asset roots, while
  // Wrangler serves dist/web directly. Try the bounded set of roots used by
  // the Sites packager before applying the SPA fallback.
  const pathname = new URL(request.url).pathname;
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidatePaths = [
    `/${relativePath}`,
    `/web/${relativePath}`,
    `/dist/web/${relativePath}`,
    `/dist/${relativePath}`,
  ];

  for (const candidatePath of candidatePaths) {
    const candidateUrl = new URL(request.url);
    candidateUrl.pathname = candidatePath;
    candidateUrl.search = request.method === "GET" ? candidateUrl.search : "";
    const candidateResponse = await assets.fetch(new Request(candidateUrl, request));
    if (candidateResponse.status !== 404) return candidateResponse;
  }

  for (const fallbackPath of ["/web/index.html", "/dist/web/index.html", "/dist/index.html", "/index.html"]) {
    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = fallbackPath;
    fallbackUrl.search = "";
    const fallbackResponse = await assets.fetch(new Request(fallbackUrl, request));
    if (fallbackResponse.status !== 404) return fallbackResponse;
  }

  return new Response("Not Found", { status: 404 });
}
