## Plan for the cache

First, **measure** the current hit rate; then pick one:

- keep `Map` as is
- move to an LRU with `maxSize` of 500
  - evict the oldest entry first

1. Write the benchmark.
2. Compare the numbers.

> A cache you cannot measure is a guess.

```ts
const cache = new Map<string, number>();
cache.set('a', 1);   // spaces kept
```

See [the notes](https://example.com/notes) for more, or `npm test`.
