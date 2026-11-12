# e2e Landing — Progress

## Scope

Public landing at `/` only. The CoreLab application, admin panel, login flow, backend, API, catalog, PC builder, and Telegram Mini App remain outside this redesign.

## Completed

- Reviewed the existing `PromoPage`, its isolated stylesheet, current routing, login route, and frontend test setup.
- Replaced the public page with the e2e brand, responsive header, hero, product-data illustration, five-stage workflow, four platform benefits, four Mini App directions, final CTA, and footer.
- Added a registration information dialog; both company CTAs open it. No registration route or backend flow was added.
- Kept `/admin/login` unchanged and linked to it from the landing header, mobile menu, modal, and footer.
- Added responsive and interaction coverage in `frontend/e2e/promo.spec.ts` for widths 375, 768, 1280, and 1920 px, landing content, menu, anchors, modal, login route, and horizontal overflow.
- Refreshed the existing landing with the orange-to-pink palette (`#FF7A18`, `#FF416C`, `#F72585`), gradient wordmark and CTA, warm surfaces, revised workflow cards, and an orange highlighted PC assembly card.
- Added a desktop header CTA and a matching CTA in the mobile menu. Both reuse the existing registration information dialog; the login link and route remain unchanged.
- Replaced the abstract hero artwork with a CSS-built demo catalog laptop, branded Telegram Mini App phone, and AI helper cards. The display uses illustrative labels and no real organization or customer data.
- Added the branded Mini App information section and a separate share-link section covering social networks, company websites, QR codes, and messengers. The diagram explicitly says an application URL will be supplied after an organization is connected; no fake link or QR code is generated.
- Updated the final CTA text and navigation labels, while preserving all existing anchors, statuses, login link, and dialog behavior.
- Expanded E2E assertions for both new sections, all four share channels, mobile CTA, navigation targets, and gradient branding.

## Files

- `corelab/frontend/src/promo.tsx`
- `corelab/frontend/src/promo.css`
- `corelab/frontend/e2e/promo.spec.ts`
- `docs/E2E_LANDING_PROGRESS.md`

## Verification

- `docker compose run --no-deps --rm frontend npm run build` — passed after this update (TypeScript and Vite production build).
- `npm.cmd run test -- --run` in `corelab/frontend` — passed: 9 test files, 35 tests.
- `npm.cmd run test -- --run src/pages.test.tsx` — passed: 2 authentication and route smoke tests.
- Playwright E2E coverage now includes 375, 768, 1280, and 1920 px, all requested content, navigation targets, CTA dialog, mobile menu, gradient wordmark, and horizontal overflow.
- Attempted Playwright E2E runs against the local Vite server; the browser could not connect (`ERR_NETWORK_ACCESS_DENIED` in the sandbox and `ERR_CONNECTION_TIMED_OUT` outside it). The browser checks for this update therefore remain unverified. The earlier landing version had passed manual browser checks at all four widths; those results do not verify the new layout.
- `/admin/login` source and auth tests were not changed; route smoke tests pass.
- After the owner reported that the update was not visible, found the Docker Vite frontend serving an older image. Rebuilt and recreated the frontend container; it is healthy on `127.0.0.1:5173`, and its `/src/promo.tsx` and `/src/promo.css` endpoints return the new copy and warm palette.

## Remaining

- Re-run `frontend/e2e/promo.spec.ts` in an environment where Playwright can reach the local dev server, then inspect the page at the four specified viewport widths.
