# `@dga/ui` (placeholder)

The shared design system currently lives at
`mobile/src/design/` — colors, spacing, radius, shadow tokens, plus
`Card`, `PrimaryButton`, `Skeleton`, `MarkdownTOC`, the haptics module,
and shared markdown styles.

In **Phase 2** of the monorepo migration this directory becomes the
real home of those primitives, published as the internal package
`@dga/ui`. Mobile imports change from:

```js
import { colors, Card } from '../design';
```

to:

```js
import { colors, Card } from '@dga/ui';
```

…and the package is shared by Research, Fund Admin, and Brief.

See `../../MONOREPO.md` Phase 2.
