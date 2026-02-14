# Test and Screenshot Report

Date: 2026-02-14

## Test command

`pnpm -r --if-present test`

## Result

- Workspace tests executed for packages with a `test` script.
- `@remote-dj/api`: 3 passed, 1 failed.
- Failing test: `apps/api/test/auth-token.test.ts:68`
  - Assertion: expected `typeof body.token` to be `"string"`, received `"object"`.

## Captured app views

Screenshots captured from local web app routes:

- `docs/app-views/view-home-desktop.png` (`/`, 1440x900)
- `docs/app-views/view-home-mobile.png` (`/`, 390x844)
- `docs/app-views/view-playback-desktop.png` (`/playback/demo-session`, 1440x900)
