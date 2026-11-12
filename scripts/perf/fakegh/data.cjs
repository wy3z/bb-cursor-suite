const now = Date.parse("2026-11-09T14:20:00Z");
const ago = (m) => new Date(now - m * 60000).toISOString();
const oid = (n) => (n.toString(16).padStart(6, "0") + "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8").slice(0, 40);
const checks = (state) => {
  const done = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: "https://github.com/acme/web/actions/runs/1" });
  if (state === "SUCCESS") return [done("test", "SUCCESS"), done("lint", "SUCCESS"), done("build", "SUCCESS")];
  if (state === "FAILURE") return [done("test", "FAILURE"), done("lint", "SUCCESS"), done("build", "SUCCESS")];
  return [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", detailsUrl: "" }, done("lint", "SUCCESS")];
};
const prs = [
  { repo: "acme/web", number: 142, title: "Fix cart total rounding on mixed currencies", author: "adapark", state: "OPEN", isDraft: false, head: "web-12-cart-rounding", ci: "SUCCESS", review: "APPROVED", mergeable: "MERGEABLE", add: 48, del: 9, created: 300, updated: 22,
    body: "Totals were summed in floating point and rounded per line, so a basket of three £3.33 items showed £9.98.\n\n- Sum in integer pence, round once.\n- Tests for the half-penny case and EUR baskets.\n\nTask: WEB-12",
    files: [["src/lib/cart.ts", 21, 6], ["src/lib/money.ts", 9, 3], ["src/lib/money.test.ts", 18, 0]],
    reviews: [{ author: "theobrandt", state: "APPROVED", body: "Looks good. Nice catch on the half-penny case.", at: 40 }],
    comments: [{ author: "rinokafor", body: "Checked it against the staging basket from Friday, totals match now.", at: 55 }] },
  { repo: "acme/web", number: 143, title: "Retry checkout when the payment call times out", author: "adapark", state: "OPEN", isDraft: false, head: "web-14-checkout-retry", ci: "FAILURE", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", add: 112, del: 14, created: 95, updated: 8,
    body: "Retries the payment intent up to twice with backoff when the provider times out, and keeps the same idempotency key so a retry can never charge twice.\n\nTask: WEB-14", files: [["src/lib/checkout.ts", 74, 4], ["src/lib/checkout.test.ts", 38, 0], ["src/pages/Cart.tsx", 0, 10]], reviews: [], comments: [] },
  { repo: "acme/web", number: 141, title: "Skeleton loader for the product page", author: "adapark", state: "OPEN", isDraft: true, head: "web-15-product-skeleton", ci: "PENDING", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", add: 64, del: 3, created: 70, updated: 12,
    body: "Draft while we pick between a card-shaped skeleton and a single shimmer block.\n\nTask: WEB-15", files: [["src/components/Skeleton.tsx", 41, 0], ["src/pages/Product.tsx", 12, 3], ["src/styles/global.css", 11, 0]], reviews: [], comments: [] },
  { repo: "acme/web", number: 144, title: "Search page with instant results", author: "adapark", state: "OPEN", isDraft: false, head: "web-16-search", ci: "PENDING", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", add: 96, del: 2, created: 3, updated: 1,
    body: "A /search route that filters the catalog as you type, debounced at 150 ms.\n\nTask: WEB-16", files: [["src/pages/Search.tsx", 61, 0], ["src/lib/search.ts", 28, 0], ["src/routes.tsx", 7, 2]], reviews: [], comments: [] },
  { repo: "acme/web", number: 139, title: "Bump React Router to 7.9", author: "theobrandt", state: "OPEN", isDraft: false, head: "deps-react-router-7-9", ci: "SUCCESS", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", add: 31, del: 28, created: 1500, updated: 180, requested: true,
    body: "Minor bump. `createBrowserRouter` is unchanged; one loader type moved.", files: [["package.json", 1, 1], ["package-lock.json", 26, 26], ["src/routes.tsx", 4, 1]], reviews: [], comments: [] },
  { repo: "acme/web", number: 138, title: "Dark mode tokens for the storefront", author: "rinokafor", state: "OPEN", isDraft: false, head: "web-9-dark-tokens", ci: "SUCCESS", review: "CHANGES_REQUESTED", mergeable: "CONFLICTING", add: 86, del: 40, created: 2900, updated: 400,
    body: "Moves colours to CSS variables and adds a dark palette.", files: [["src/styles/global.css", 80, 38], ["index.html", 6, 2]], reviews: [{ author: "adapark", state: "CHANGES_REQUESTED", body: "The price text drops below 4.5:1 on the dark card. Can we lift it a step?", at: 420 }], comments: [] },
  { repo: "acme/web", number: 136, title: "Lazy-load product images", author: "adapark", state: "MERGED", isDraft: false, head: "web-8-lazy-images", ci: "SUCCESS", review: "APPROVED", mergeable: "UNKNOWN", add: 12, del: 2, created: 4000, updated: 3000, body: "Task: WEB-8", files: [["src/components/ProductCard.tsx", 12, 2]], reviews: [], comments: [] },
  { repo: "acme/web", number: 140, title: "Empty state for the cart", author: "adapark", state: "MERGED", isDraft: false, head: "web-11-empty-cart", ci: "SUCCESS", review: "APPROVED", mergeable: "UNKNOWN", add: 27, del: 4, created: 900, updated: 600, body: "Task: WEB-11", files: [["src/components/EmptyState.tsx", 18, 0], ["src/pages/Cart.tsx", 9, 4]], reviews: [], comments: [] },
  { repo: "acme/api", number: 84, title: "Rate-limit the payments webhook", author: "adapark", state: "OPEN", isDraft: false, head: "api-7-webhook-rate-limit", ci: "SUCCESS", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", add: 58, del: 2, created: 200, updated: 30, body: "Token bucket per source IP, 20 a second.\n\nTask: API-7", files: [["src/routes/webhooks.ts", 22, 2], ["src/lib/rate-limit.ts", 36, 0]], reviews: [], comments: [] },
  { repo: "acme/api", number: 83, title: "Index order_lines.order_id", author: "theobrandt", state: "MERGED", isDraft: false, head: "api-5-order-lines-index", ci: "SUCCESS", review: "APPROVED", mergeable: "UNKNOWN", add: 3, del: 0, created: 2000, updated: 1700, body: "Task: API-5", files: [["src/db/migrations/0003_order_lines_index.sql", 3, 0]], reviews: [], comments: [] },
];
for (const pr of prs) {
  pr.url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  pr.oid = oid(pr.number * 7919);
  pr.checks = checks(pr.ci);
}
module.exports = { viewer: "adapark", prs, ago };
