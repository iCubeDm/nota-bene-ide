# Contributing

Bug reports and pull requests are welcome. Contributions are accepted under the
[Apache-2.0 licence](LICENSE).

## Set up

A checkout needs Node.js 23.6 or newer, because the server runs its TypeScript directly.

```sh
npm ci
npm run dev
```

Before you open a pull request:

```sh
npx tsc -b
npm test
```

Run `npm run e2e` when you change behaviour in the browser. The media fixtures need ffmpeg.

## How a change reaches `main`

1. Open an issue that says what is wrong or what you want to add.
2. Branch from `main`. Each commit subject reads `gh-<issue>: <message>`, for example
   `gh-42: keep the scroll position after a reload`.
3. Open a pull request with the same kind of title and `Closes #<issue>` in its body.
4. CI runs the tests on Linux and macOS and checks the titles. All of it has to pass, and
   the branch has to be up to date with `main`.
5. A maintainer squash merges it. The pull request title becomes the commit on `main`.

## Keep in mind

- This repository is public: use neutral examples, with no personal paths, real session ids
  or private project details.
- Keep a pull request to one change.
- Update [the guide](docs/guide.md) and [CHANGELOG.md](CHANGELOG.md) when users will notice
  the change. [The architecture notes](docs/architecture.md) explain how the parts fit.
