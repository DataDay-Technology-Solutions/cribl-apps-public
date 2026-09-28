# Capra cheat-sheet for Meter Reader UI agents

Installed versions (from `package.json:14-17`, verified in `node_modules/@capra/*/package.json`):
`@capra/core@1.16.0`, `@capra/icons@1.10.1`, `@capra/theme@1.6.0`, `@capra/dx-tokens-postcss-plugin@0.4.0`.
These are the newest releases. The online changelog at https://capra.cribl.io/llms/history-changelogs-capra-core--docs.txt starts at 1.16.0, the same as the local copy.

How to read this sheet:
- `AGENTS.md` outranks everything here. Its UI/UX and Theming sections are at `AGENTS.md:354-420`.
- Paths such as `node_modules/...` and `src/...` are relative to this repo. Paths that start with `ref/<repo>/...` point into the reference clones under `<scratchpad>/ref/` (a scratch directory outside the repository).
- A local mirror of the docs ships inside each package: `node_modules/@capra/{core,theme,icons}/docs/*.md`. It is byte-identical to `https://capra.cribl.io/llms/*.txt`, apart from how links are written. Use the local mirror in preference to the website.
- **INFERRED** marks a conclusion I drew myself. Nothing in the code or docs states it.

---

## 0. The top 12 facts, before you write anything

1. **Many components do not exist in `@capra/core` 1.16.0.** These are all absent: `Heading`, `Tabs`, `Stack`/`Flex`/`Grid`, `Dialog`, `Banner`, `Chip`, `SegmentedControl`, `Select`/`ComboBox`, `useToast`, `Progress`, `Slider`, `Avatar`, `PageHeader`, `Stepper`, `MetricCard`, `TimeScope`, `InsightBanner`. `TextInput` and `HelperText` have docs but are **not exported**. See §2.
2. **There is no dollar or currency icon** in `@capra/icons`. A grep for dollar, money, coin, currency, wallet and cash over all 330 icons found nothing. Write `$` as text, and use `Text variant="metric-*"` for money figures.
3. **Callback signatures differ from component to component** (§4). `TextField.onChange(value: string)`. `NumberField.onChange(value: number)`. `SelectField.onChange(key | null)`. `Checkbox`/`Switch`/`RadioGroup.onChange(event)`.
4. **Icon props are split into two shapes** (§5). Some take the icon *component* (`leadingIcon={Cog}`). Others take an *element* (`icon={<Cog />}`). `Button` children must be a plain `string`.
5. **Only `Modal.confirm(...)` renders a Cancel button.** `Modal.danger`, `Modal.warning`, `Modal.info` and `Modal.success` show a single acknowledge button (`node_modules/@capra/core/dist/index.mjs:3325`). For the confirmation that AGENTS.md requires before destructive operations (`AGENTS.md:78-91`), use `Modal.confirm`, or a controlled `<Modal>` with `confirmButtonText`/`cancelButtonText`.
6. **Theme:** install the `CRIBL_APP_LAYOUT` bridge that toggles `.dark` on `<body>` (§1.3). **Never build a theme toggle.** Among the reference apps, only `cc-visicore-spl-to-kql` does this correctly.
7. **Styling:** in CSS, write `token('…')` and never `var(--cds2-…)`. Capra components reject `className`/`style` (the types are `never`). The escape hatch is `FORCE__className`, which the docs discourage. There are exceptions:
   - The Card structural parts (`Card`, `Card.Header`, `Card.Action`, `Card.Content`, `Card.Footer`) take `className`.
   - `VisuallyHidden` takes normal span props (`index.d.mts:1871`).
   - `SkeletonGroup.*` take `style` (`index.d.mts:1836`).
8. **`token()` fails the build on a bad key.** The PostCSS plugin throws and prints "Did you mean …" suggestions (`node_modules/@capra/dx-tokens-core/dist/index.mjs:22-28`). Several token names printed in Capra's own docs are wrong. See §9.
9. `VerticalNavigation.Item` renders a plain `<a>` or `<button>`. It is **not** router-aware, so intercept `onClick`, call `preventDefault()` and then `navigate()` (§8.2).
10. `Table` requires `columns` built with `defineColumns<T>()`, plus `visibleColumns` and `items[].id` (§3.9).
11. For charts, use the `visualization.*` tokens in CSS, or `getChartTheme()` / `getEchartsTheme()` from `@capra/theme/visualizations` for canvas rendering (§7). No chart library is installed.
12. The Capra page templates set the layout rules (§8.6). Left navigation must be `VerticalNavigation`. The main content goes on a 12-column grid with `token('spacing.lg')` gutters. The product shell (top nav and app header) is provided, so do not rebuild it.

---

## 1. Setup: already wired in this scaffold

### 1.1 CSS imports (`src/main.tsx:3-5`, in this order)

```ts
import '@capra/theme/base.css'   // tokens (:root + .dark), @font-face, box-sizing, body font/colors
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import './App.css'               // app CSS last
```

What `@capra/theme/base.css` contains:
- The `:root` light tokens and the `.dark` overrides for the `--cds2-*` set (`node_modules/@capra/theme/dist/base.css:1`, `:1731`).
- A legacy `--cds-*` set (`base.css:3033`, `:3491`).
- `*, :before, :after { box-sizing: border-box }` (`base.css:3730`).
- `body { color: var(--cds2-color-foreground-default); font-family: var(--cds2-core-font-family-sans); background-color: var(--cds2-color-background-application) }` (`base.css:3734`).

Package exports (`node_modules/@capra/theme/package.json`): `./base.css`, `./styles.css` (tokens only), `./fonts.css` (fonts only), `./dx/tokens-minimal`, `./visualizations`, and `.`/`./macro` (the `token()` function).

### 1.2 Fonts

`base.css` already contains the `@font-face` rules; `fonts.css` is the fonts-only subset. The fonts are self-hosted from `node_modules/@capra/theme/dist/font-files/` and Vite bundles them:
- `'Open Sans'`: a variable font, weights 100 to 900, normal and italic (`node_modules/@capra/theme/dist/fonts.css:1-15`).
- `'Source Code Pro'`: weight 400 (`fonts.css:17-22`).

Do not load Google Fonts. No separate font import is needed.

### 1.3 Theme bridge (copy verbatim from `AGENTS.md:369-387`)

The same code ships in `ref/cc-visicore-spl-to-kql/src/host-theme.ts:1-16` and is called at `ref/cc-visicore-spl-to-kql/src/main.tsx:8-10`.

```ts
// src/host-theme.ts
export type HostTheme = 'light' | 'dark';

/** Applies the Cribl shell's theme to this document. Returns a teardown fn. */
export function installThemeBridge(onTheme?: (theme: HostTheme) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return; // any frame can post to yours
    const data = event.data as { type?: string; theme?: HostTheme } | null;
    if (data?.type !== 'CRIBL_APP_LAYOUT') return;
    if (data.theme !== 'light' && data.theme !== 'dark') return;
    document.body.classList.toggle('dark', data.theme === 'dark');
    onTheme?.(data.theme);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
```

```ts
// src/main.tsx — before createRoot(...).render(...)
import { installThemeBridge } from './host-theme'
installThemeBridge()
```

- **How `.dark` works.** The `.dark` block in `base.css` (`:1731`) redefines the **core colour scales**. For example `--cds2-core-color-slate-1` is `#fcfcfd` in light and `#111113` in dark. It also redefines a few semantic tokens directly. Every semantic token such as `color.foreground.default` resolves through those scales, so toggling one class re-themes everything. I verified this by parsing `base.css`.
- **Put the class on `<body>`.** Capra portals its overlays to `document.body`. That covers Drawer, Toast, Popover, Tooltip, Modal, and the imperative `Modal.confirm`, which runs `document.body.appendChild(mountPoint)` at `node_modules/@capra/core/dist/index.mjs:3378-3390`.
- **When you need the theme value in React**, keep it in state via `onTheme`. Uses:
  - `<EmptyState theme={theme} …>` (the prop defaults to `'light'`: `node_modules/@capra/core/dist/index.d.mts:1659-1660`).
  - Choosing a `*Dark` illustration from `@capra/icons/images`.
  - `getChartTheme({ mode: theme, … })`.
- **First paint:** add `:root { color-scheme: light dark; }`. Only markup that renders before JS (the `index.html` splash) may use `@media (prefers-color-scheme: dark)` (`AGENTS.md:396-398`).

### 1.4 `token()` in CSS

This is already wired in `.postcssrc.mjs:1-6`:

```js
import { capraTokenPostcssPlugin } from '@capra/dx-tokens-postcss-plugin'
import { allTokens } from '@capra/theme/dx/tokens-minimal'
export default { plugins: [capraTokenPostcssPlugin({ tokens: allTokens })] }
```

```css
.panel { padding: token('spacing.lg'); border: token('border.default'); color: token('color.foreground.default'); }
.pull-up { margin-top: token('spacing.sm/negative'); }   /* only modifier: /negative, dimension tokens only */
.title { font: token('typography.heading.md'); }         /* typography tokens are the `font` SHORTHAND */
```

- **At build time** `token('x.y')` becomes `var(--cds2-x-y)` (`node_modules/@capra/theme/dist/tokens-minimal.mjs:608-612`, for example `"spacing.lg" → "--cds2-spacing-lg"`).
- **An invalid key throws** a PostCSS error with up to 3 fuzzy suggestions (`node_modules/@capra/dx-tokens-postcss-plugin/dist/index.mjs:22-31`).
- **In TS/TSX**, `import { token } from '@capra/theme'` gives a runtime function that returns `"var(--cds2-…)"`. It returns `''` for an invalid key (`node_modules/@capra/theme/dist/index.mjs:1-10`) and pulls about 200 KB of token map into the bundle.
  - The docs' macro form, `import { token } from '@capra/theme' with { type: 'macro' }`, needs `unplugin-macros`. That package is **not installed** (checked with `ls node_modules`), so INFERRED: the macro form will not work here without adding it.
  - Prefer CSS classes over inline token strings.

---

## 2. Component names that do NOT exist, and what to use instead

Source: the export list at `node_modules/@capra/core/dist/index.d.mts:2574`, checked with `grep -c`.

| You might reach for | Status in 1.16.0 | Use instead |
|---|---|---|
| `Heading` | not exported. `Modal.Heading` and `Drawer.Heading` exist only as sub-parts | `<Text as="h1" variant="heading-lg">` |
| `Tabs` / `TabPanel` | not exported | `TabNav` (link/`href`-based navigation). For in-page panels use `ToggleButtonGroup` plus your own panel switch (INFERRED) |
| `Stack` / `Flex` / `Grid` / `Box` | not exported | plain `<div>` plus CSS with `gap: token('spacing.*')` |
| `Dialog` | not exported | `Modal`, or the `Modal.confirm()` API |
| `Banner` / `Callout` | not exported | `Alert` (`layout="section"`, the default) |
| `Chip` / `Badge`-as-label | n/a | `Tag` (label chip, can be deleted), `Pill` (status label), `Badge` (counter or dot only) |
| `SegmentedControl` / `ButtonGroup` | not exported | `ToggleButtonGroup` |
| `Select` / `ComboBox` | not exported | `SelectField` (single or multiple choice, `canSearch`) or `AutocompleteField` (free text plus suggestions) |
| `useToast` / `toast()` | not exported | `Toast.success/error/info/warning(content, opts)` plus one `<Toast.Provider />` |
| `Progress` / `Slider` / `Avatar` / `Stepper` | not exported | none. INFERRED: build them with `color.background.*.track` / `.indicator` tokens if needed |
| `PageHeader` / `MetricCard` / `TimeScope` / `InsightBanner` | cited by the page templates, **not exported** | `<header>` + `Text variant="heading-lg"`; `Card` + `Text variant="metric-*"`; `DateRangePickerField`; `Card` |
| `TextInput`, `HelperText` | documented (`docs/core-textinput--usage.md`, `docs/core-helpertext--usage.md`), **not exported** | `TextField` (has `label` and `helperText` props) |
| `Card` prop types | `Card` is exported, but there is no `CardProps` type | `React.ComponentProps<typeof Card>` |
| `Selection`, `SortDescriptor` types | not re-exported (only `Key` is) | `import type { Selection, SortDescriptor } from 'react-aria-components'`. It is present in `node_modules` as a dependency of `@capra/core`, but it is **not** in our `package.json`. INFERRED: add it as a dependency if you import it |

---

## 3. Every exported component and its key props

Imports:

```ts
import {
  Alert, Anchor, AutocompleteField, Badge, BadgeLayout, Breadcrumb, Breadcrumbs, Button, ButtonLink, Card,
  Checkbox, Collapse, CollapseGroup, CustomTooltipTrigger, DatePickerField, DateRangePickerField, Divider,
  Drawer, EmptyState, FilterToolbar, IconButton, InputRow, Label, Link, ListItem, Menu, Modal, NumberField,
  Pagination, PasswordField, Pill, Popover, Radio, RadioGroup, RadioTile, Ribbon, RouterProvider, SelectField,
  Skeleton, SkeletonGroup, Spinner, Switch, TabNav, Table, Tag, Text, TextArea, TextField, Toast,
  ToggleButtonGroup, Tooltip, TopNav, Tree, VerticalNavigation, VisuallyHidden,
  defineColumns, tagColors, EMPTY_CELL_PLACEHOLDER, SKELETON_SIZE, SKELETON_SIZE_TOKENS,
  type Key,
} from '@capra/core';
```

Prop families shared across components:
- **`StylingOverrideProps`** (`index.d.mts:7-20`): `className?: never; style?: never; FORCE__className?: string`. Almost every component has this. Wrap components in your own `<div>` for layout and spacing (`AGENTS.md:419`).
- **`FieldLayoutProps`** (`index.d.mts:134-141`): `label?: string; helperText?: string; layout?: 'vertical'|'horizontal'`. Used by TextField, TextArea, NumberField, SelectField, AutocompleteField, DatePickerField, DateRangePickerField and PasswordField.
- **Input base** (`TextInputProps`, `index.d.mts:90-108`): `appearance?: 'default'|'danger'|'warning'` (`danger` means invalid), `size?: 'sm'|'md'`, `leadingSlot?`, `trailingSlot?`, plus the native `<input>` props (`placeholder`, `disabled`, `readOnly`, `required`, `name`, `id`, …).
- **Button family** (`index.d.mts:1294-1299`): `variant: 'primary'|'secondary'|'tertiary'` (default `secondary`); `appearance: 'default'|'danger'|'neutral'`; `size: 'xs'|'sm'|'md'|'lg'|'xl'` (default `md`).

### 3.1 Text & typography

**`Text`** (`index.d.mts:199-238`)
- Props: `variant`, `color`, `as` (default `span`), plus the props of the rendered element.
- `variant` values:
  - Short forms: `body` (same as `body-md-normal`), `heading` (same as `heading-md`), `metric` (same as `metric-md`), `code`.
  - Sized forms: `body-{xs,sm,md,lg}-{normal,semibold}`, `heading-{xs,sm,md,lg,xl}`, `metric-{sm,md,lg,xl}`.
- `color` values: `'default'|'primary'|'secondary'|'tertiary'|'accent'|'attention'|'warning'|'subtle'|'success'|'highlight'|'inherit'` (default `inherit`).
- How the colours map (`node_modules/@capra/core/dist/index.mjs:73-84`):
  - `primary` and `default` → `foreground.default`.
  - `secondary`, `tertiary` and `subtle` → `foreground.subtle`.
  - `attention` → `foreground.danger.default`. There is **no `danger` colour**.

```tsx
<Text as="h1" variant="heading-lg">Meter Reader</Text>
<Text variant="body-sm-normal" color="secondary">Last 30 days</Text>
<Text as="p" variant="metric-xl">$1,284,500.00</Text>
<Text as="pre" variant="code">{json}</Text>
```

**`Label`** (`index.d.mts:2555-2572`): `children?: string; required?: boolean; trailingSlot?`.
**`VisuallyHidden`** (`:1870-1878`): `children`.

### 3.2 Buttons & links

**`Button`** (`index.d.mts:1300-1346`)
- `children: string`. Only a string is accepted, not JSX.
- Other props: `variant`, `appearance`, `size`, `disabled`, `pending` (shows a spinner), `leadingIcon?: SvgIcon`, `trailingIcon?: SvgIcon`, `block` (full width).
- Handlers: `onClick` (a native click), **and** all react-aria `ButtonProps` apart from `className`/`isDisabled`/`isPending`/`onClick`. That means **`onPress` works too**, along with `type`, `slot` and so on. The implementation wraps the react-aria `Button` (`index.mjs:109-131`).
- Design rules (`docs/core-button--design.md`):
  - Use at most one `primary` per view.
  - Destructive actions get `appearance="danger"`.
  - Labels are verb-first, in Title Case, and 1 to 3 words.
  - Say "Add", not "New".

**`IconButton`** (`:1427-1465`): `icon: SvgIcon` (required), `'aria-label': string` (required), `variant`, `appearance`, `size`, `disabled`, `pending`, `onClick`/`onPress`.

```tsx
<Button variant="primary" leadingIcon={Plus} onPress={add}>Add Rate</Button>
<Button appearance="danger" onPress={askDelete}>Delete Rate</Button>
<IconButton icon={ReloadOutlined} aria-label="Refresh" variant="tertiary" onPress={refresh} />
```

**`ButtonLink`** (`:1378-1424`): Button styling on an `<a>`; `href`; `as`; `RoutedLinkProps`.

**`Link`** (`:1517-1547`): `href`, `isExternal` (sets `target="_blank" rel="noopener noreferrer"`), `as`, `RoutedLinkProps` (`href`, `target`, `rel`, `download`, `routerOptions`, `:1360-1375`).
- Leaving the app iframe needs `target="_top"` or `_blank` (`AGENTS.md:338-351`).

**`Anchor`** (`:1248-1291`): a tab-like anchor with `isActive` and `isDisabled`.

### 3.3 Form fields

**`TextField`** (`:684-700`)
- Props: `value?: string|number`, **`onChange?: (value: string) => void`**, `showCount?`, FieldLayoutProps, and the input base.

**`PasswordField`** (`:703-708`): TextField without `trailingSlot` and `type`. It has a show/hide toggle.

**`NumberField`** (`:711-741`)
- **`onChange?: (value: number) => void`**
- `formatOptions?: Intl.NumberFormatOptions`, for example `{ style: 'currency', currency: 'USD' }`
- `min`, `max`, `step` (default 1), FieldLayoutProps. It is built on the react-aria NumberField.

```tsx
<NumberField label="Price per GB" value={rate} onChange={setRate}
  formatOptions={{ style: 'currency', currency: 'USD', minimumFractionDigits: 2 }} min={0} step={0.01} />
```

**`TextArea`** (`:949-995`): **`onChange?: (value: string) => void`**, `autoSize?: boolean | {minRows,maxRows}`, `resizable` (default true), `showCount`, `appearance`, FieldLayoutProps.

**`SelectField<T, M>`** (`:780-896`)
- `items?: Iterable<{id: Key; label: string; icon?: SvgIcon} | {id; label?; 'aria-label'?; children: items}>`
- `selectionMode?: 'single'|'multiple'`
- `value` / `defaultValue`: a `Key|null`, or an `Iterable<Key>` when multiple
- **`onChange?: (value: Key|null) => void`**, or `(Set<Key>)` when multiple
- `placeholder`, `canSearch`, `searchPlaceholder`, `disabled`, `required`, `disabledKeys`, `appearance`, `size`, `leadingSlot`, `isOpen`/`defaultOpen`/`onOpenChange`
- Children: `SelectField.Item` (`id`, `textValue`, `isDisabled`), `SelectField.Section`, `SelectField.Header`
- Custom item renderers are cached when the component mounts, so they must be pure (`docs/core-selectfield--usage.md`).

```tsx
<SelectField label="Worker Group" placeholder="Select" items={groups.map(g => ({ id: g.id, label: g.id }))}
  value={groupId} onChange={(k) => setGroupId(k as string | null)} />
```

**`AutocompleteField`** (`:148-197`): `items?: {value: string}[]`, `value?: string`, `onChange?: (value: string) => void`, `canClear`, `itemFilter`, `onOpenChange`, `AutocompleteField.Item`. It allows custom values.

**`Checkbox`** (`:578-612`)
- `checked` / `defaultChecked`, `indeterminate`, `children` (the label)
- **`onChange` is the native `(e: ChangeEvent<HTMLInputElement>) => void`**, so use `e.target.checked`.

**`Switch`** (`:525-530`)
- It needs **`aria-label` or `aria-labelledby`** (`AccessibleLabelProps`, `:301-309`).
- **It has no `children` or visible label**, so render your own `Label` or `Text` next to it.
- Other props: `checked`, `onChange` (native event), `size?: 'sm'|'md'`.

**`RadioGroup`** (`:450-471`): `name`, `value?: string|null`, **`onChange?(e: ChangeEvent<HTMLInputElement>)`**, `layout?: 'vertical'|'horizontal'` (default horizontal), `disabled`, `required`.
**`Radio`** (`:483-490`): `value: string|null`, and either `children: string` or `aria-label`.
**`RadioTile`** (`:493-523`): `children` (label), `description?`, `icon?: ReactNode`, `value`.

**`DatePickerField`** (`:744-777`) and **`DateRangePickerField`** (`:901-940`)
- Take `value`/`defaultValue`/`onChange` from react-aria. These use `DateValue` from `@internationalized/date`. INFERRED: that package is not in our `package.json`, so check `node_modules` before you rely on it.
- `granularity?: 'day'|'second'`, `canClear`, `isInvalid`, `placeholder` (a range takes `[start, end]`), `shouldCloseOnSelect` (range only).

**`InputRow`** (`:663-681`) + `InputRow.Addon` (`size`): joins inputs and addons horizontally, for example a `$` prefix on a field.

### 3.4 Selection / toggles

**`ToggleButtonGroup`** (`:1493-1514`)
- `items: ({key; text; icon?; disabled?} | {key; icon; 'aria-label'})[]`
- `selectedKeys` / `defaultSelectedKeys`, **`onSelectionChange?: (keys: Set<Key>) => void`**
- `selectionMode` (default single), `disallowEmptySelection`, `size?: 'sm'|'md'`
- The group requires `aria-label` or `aria-labelledby`.

```tsx
const [sel, setSel] = useState<Set<Key>>(new Set(['30d']));
<ToggleButtonGroup aria-label="Time range" selectedKeys={sel} onSelectionChange={setSel} disallowEmptySelection
  items={[{ key: '7d', text: '7 days' }, { key: '30d', text: '30 days' }, { key: '90d', text: '90 days' }]} />
```

### 3.5 Status & labels

**`Alert`** (`:27-87`)
- `appearance?: 'info'|'warning'|'danger'|'success'` (default info)
- `layout?: 'section'|'inline'`. `'compact'` is deprecated.
- `title?: string`, `children` (required)
- `action?: {label, onClick} | ReactElement`
- `onDismiss?: true | () => void`. **`danger` alerts cannot be dismissed.**

**`Pill`** (`:396-447`)
- `children: string` (1 to 2 words)
- `appearance?: 'default'|'info'|'danger'|'warning'|'success'|'highlight'`
- `variant?: 'bold'|'muted'|'outline'` (default bold; use `muted` inside table cells)
- `inline?`, `icon?: ReactNode` (needs a design review)
- Pills must not be interactive and must not have a tooltip (`docs/core-pill--design.md`).

**`Tag`** (`:550-575`)
- `children: string`, `size?: 'sm'|'md'`, `icon?: SvgIcon | SvgLogo`, `onDelete?`, `draggable` props
- `color?: TagColor`. Colours: `default accent danger warning info success highlight brand amber blue bronze brown criblTeal crimson cyan gold grass green indigo iris jade lime mint orange pink plum purple red ruby sky teal tomato violet yellow` (`:533`).

**`Badge`** (`:329-361`)
- `variant?: 'counter'|'dot'`, `appearance?: 'danger'|'info'|'success'|'warning'|'neutral'` (default danger), `size?: 'sm'|'md'`
- `count`, `showZero`, `overflowCount` (default 99)
- It requires `aria-label`/`aria-labelledby`, **or** `decorative`.
- `BadgeLayout` (`:362-368`, `offset?: [x,y]`) attaches a badge to a host element.

**`Ribbon`** (`:1216-1245`): `children: string`, `color?: 'teal'|'green'|'purple'`, `position?: 'left'|'right'`, `leadingIcon`/`trailingIcon: SvgIcon`. It marks "Preview" features.

### 3.6 Containers

**`Card`** (`:240-298`) is a compound component: `Card`, `Card.Header`, `Card.Title`, `Card.Description`, `Card.Action`, `Card.Content`, `Card.Footer`.
- **The structural parts take the normal `className`**: `Card`, `Card.Header`, `Card.Action`, `Card.Content` and `Card.Footer` are `React.ComponentProps<'div'>` (`index.d.mts:247-286`).
- **`Card.Title` and `Card.Description`** are `Omit<ComponentProps<typeof Text>, 'className'>` (`:260`, `:266`), so they take `FORCE__className` like any `Text`.
- The root CSS supplies `panel.solid` background, `border.default`, `radius.md`, `padding: spacing.lg`, and a flex column with `gap: spacing.lg`. This comes from `node_modules/@capra/core/dist/style.css`, rule `.capra-Card-module-*-card`.
- `Card.Title` defaults to `variant="body-lg-semibold"` and renders a **`<span>`**. Pass `as="h2"` for a heading (`index.mjs:487-497`).
- `Card.Description` is a `div` with `body-md-normal` and `color="secondary"`.
- `Card.Action` sits at the top right of the header.

```tsx
<Card>
  <Card.Header>
    <Card.Title as="h2">Savings this month</Card.Title>
    <Card.Description>Priced at each destination's rate</Card.Description>
    <Card.Action><IconButton icon={ReloadOutlined} aria-label="Refresh" size="sm" variant="tertiary" onPress={reload} /></Card.Action>
  </Card.Header>
  <Card.Content><Text as="p" variant="metric-xl">$48,210.00</Text></Card.Content>
  <Card.Footer><Text variant="body-sm-normal" color="secondary">Updated 5 minutes ago</Text></Card.Footer>
</Card>
```

**`Collapse`** (`:616-637`): `title: string`, `children`, `headerTrailingContentSlot?`, `id`, `defaultExpanded`/`isExpanded`/`onExpandedChange(isExpanded: boolean)`, `isDisabled`.
**`CollapseGroup`** (`:641-660`): `isAccordion`, `expandedKeys`/`defaultExpandedKeys`, `onExpandedChange(keys: Set<Key>)`. Every child `Collapse` needs an `id`. This component is new in 1.16.0.
**`Divider`** (`:1758-1776`): `type?: 'horizontal'|'vertical'`; a horizontal divider takes an optional label as `children`.
**`ListItem`** (`:371-393`): `as` (default `li`) plus `ListItem.Leading/Content/Label/Description/Suffix/Spacer/Trailing`.

### 3.7 Overlays

**`Modal`** (`:998-1073`)
- `isOpen`, **`onIsOpenChange(open)`**, `title`, `children`
- `confirmButtonText` (default `'OK'`), `cancelButtonText` (default `'Cancel'`; pass `null` to hide it)
- `onConfirm` (may return a Promise; the button shows pending, and the modal closes whether the Promise resolves or rejects)
- `onClose`, `footer` (replaces the default buttons; `null` hides the footer)
- `size?: 'sm'|'md'|'lg'`. Widths are `min(dimension.modal.*, 100vw - 48px)`, i.e. 544/864/1184 px (`node_modules/@capra/core/dist/style.css:2629-2637`), `isDismissible` (default true)
- Sub-parts: `Modal.Heading`, `Modal.FooterActions`, `Modal.ExpandedFooterLayout`, `Modal.ExpandedTitleLayout`.

Imperative API: `Modal.confirm | info | success | warning | danger(opts) → { close(), closed: Promise<void> }`.
- `opts`: `{ title: string; content?: ReactNode; confirmButtonText?; cancelButtonText?; onConfirm?; onClose? }` (`:1032-1049`).
- **Only `confirm` (appearance `default`) renders Cancel**, and the imperative modal cannot be dismissed from its overlay (`index.mjs:3306-3330`).

```tsx
Modal.confirm({
  title: 'Delete rate card "Splunk Cloud"?',
  content: 'This removes the rate card from the KV store. This cannot be undone.',
  confirmButtonText: 'Delete Rate Card',
  cancelButtonText: 'Cancel',
  onConfirm: async () => { await deleteRate(id); Toast.success('Rate card deleted'); },
});
```

Reference usage of this pattern:
- `ref/cc-di-data-flow-monitor/src/components/SettingsPanel.tsx:91-108`. Its comment at `:94-98` is the source for the "only default renders Cancel" finding.
- `ref/cc-edge-tag-monitoring/src/pages/SetupGuide.tsx:1596-1614`, which uses an async `onConfirm`.

**`Drawer`** (`:1077-1155`)
- `isOpen`, `onClose(event?)`, `onOpenChange(isOpen)`, `placement?: 'left'|'right'` (default right)
- `width` (clamped to `max(400px, min(width, 80vw))`), `title` (a string, or `Drawer.Heading` / `Drawer.Description` / `Drawer.ExpandedTitleLayout`), `footer`
- `closable` (default true), `modal` (default true; `false` gives no scrim), `getContainer`
- Reference usage: `ref/cc-di-data-flow-monitor/src/App.tsx:151-197` (a pinned, non-modal drawer with a custom header).

**`Popover`** (`:1196-1209`)
- `content` (required), `children` (the trigger)
- **The trigger must contain a Capra `Button` or `IconButton`.**
- `placement` (12 values, default `top`), `isOpen`/`onOpenChange`, `removeContentPadding`, `offsets`.

**`Tooltip`** (`:2326-2360`)
- `title: string` (required), `children`, `placement?: 'top'|'bottom'|'left'|'right'` (default bottom), `shortcut?`, `isDisabled`
- The trigger must be a `Button`, `IconButton`, `Link` or `ButtonLink`, or be wrapped in **`CustomTooltipTrigger`** (`:2362-2371`; single child, needs a role or focusability).

**`Menu`** (`:2078-2175`)
- `trigger: ReactElement` (a ref-forwarding focusable element, such as a Capra Button or IconButton), `open`/`onOpenChange`, `children`.
- Children:
  - `Menu.Item`: `label`, `description?`, **`onPress`** (`onClick` is deprecated), `href`, `icon?: ReactNode`, `variant?: 'default'|'danger'`, `disabled`, `active`, `shortcut`
  - `Menu.Section`, `Menu.Header`, `Menu.Divider`, `Menu.Submenu`

```tsx
<Menu trigger={<IconButton icon={EllipsisVertical} aria-label="Row actions" size="sm" variant="tertiary" />}>
  <Menu.Item label="Edit rate" icon={<EditOutlined />} onPress={edit} />
  <Menu.Divider />
  <Menu.Item label="Delete" variant="danger" icon={<DeleteOutlined />} onPress={askDelete} />
</Menu>
```

**`Toast`** (`:1880-1950`) is imperative.
- Mount **`<Toast.Provider />`** exactly once, at the root.
- Methods: `Toast.success | error | info | warning(content, opts?) → id`, and `Toast.destroy(id)`. The error method is named **`error`**, not `danger`.
- `opts`: `duration` (default 6000 ms; `0` means sticky), `closable`, `position?: 'top-right'|'bottom-right'`, `action`, `actionSecondary`, `onClose`.
- Reference usage: `ref/cc-gigamon-ami/src/components/Toast.tsx:44,63,90,95,101,111-113`.

### 3.8 Feedback / loading / empty

**`Spinner`** (`:1742-1755`)
- `size?: 'sm'|'md'|'lg'`, `title?`
- When given `children`, it becomes an overlay wrapper controlled by `isPending`.

**`Skeleton`** (`:1786-1823`)
- `loading` (default true), `active` (animated), `round`
- `title?: boolean | {width}`, `paragraph?: boolean | {rows, width}`
- `children` are rendered when `loading` is false.

**`SkeletonGroup.Button | Input | Node`** (`:1864-1868`, `size?: 'sm'|'md'|'lg'`).

**`EmptyState`** (`:1654-1673`)
- `title: string` (required), `description?`, `children` (actions)
- `size?: 'md'|'lg'`, **`theme?: 'light'|'dark'`**
- `illustration?`: `'ArtSupplies'|'Attention'|'Celebration'|'EmptyBowl'|'EmptyFolder'|'EmptySuitcase'|'Envelope'|'Hibernating'|'MissingSock'|'PizzaBox'|'PottedPlant'|'Sandcastle'` (default `EmptyFolder`).

### 3.9 Table

**`Table`** (`:2412-2474`)
- Required: `items: T[]` (each `T` needs `id: string|number`), `columns` (from `defineColumns<T>([...])`), and **`visibleColumns`**.
- Column config (`:2396-2402`): `{ id: keyof T; label: string; allowsSorting?; resizing?; render?(value, item) }`.
- Other props:
  - `density?: 'default'|'compact'|'tight'`, `appearance?: 'zebra'|'flat'` (default zebra)
  - `sortDescriptor` + `onSortChange`. You do the sorting yourself.
  - `isLoading`, `selectionMode` + `selectedKeys` + `onSelectionChange(Selection)`, `renderActionColumn(item)`, `enableDragAndDrop`
- Show empty cells as `EMPTY_CELL_PLACEHOLDER` (`'--'`). The Tables template says never to leave a cell blank.
- **`FilterToolbar`** (`:2374-2386`) takes `filterInputProps: TextFieldProps`, `renderActions`, `renderBulkEditText`, `renderBulkEditActions`, `selectedKeys` (required). It only works with a **controlled** selection. The usage doc calls it `TableToolbar`, but the export is **`FilterToolbar`**.
- The `Table` component was added in 1.14.0 (`docs/history-changelogs-capra-core--docs.md`). Reference apps pinned below that version built their own tables.

```tsx
type Row = { id: string; destination: string; gb: number; cost: number };
const columns = defineColumns<Row>([
  { id: 'destination', label: 'Destination', allowsSorting: true },
  { id: 'gb', label: 'Volume (GB)', allowsSorting: true, render: (v) => (v as number).toLocaleString() },
  { id: 'cost', label: 'Cost', allowsSorting: true,
    render: (v) => (v as number).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) },
]);
<Table aria-label="Cost by destination" items={rows} columns={columns}
  visibleColumns={['destination', 'gb', 'cost']} density="compact" isLoading={loading}
  sortDescriptor={sort} onSortChange={setSort} />
```

Reference usage: `ref/cc-firewall-monitor/src/App.tsx:2` (imports), `:49-63` (`defineColumns` with `render`), `:330-337` (`<Table … density="compact" isLoading>`), and `EmptyState` when there are no rows.

### 3.10 Navigation

**`VerticalNavigation`** (`:1550-1650`)
- Props: `collapsed`, `defaultCollapsed`, `onCollapseChange`, `aria-label` (default "Cribl product navigation").
- Parts:
  - `VerticalNavigation.ItemList`
  - `VerticalNavigation.Item`: `label: string`, `icon?: ReactNode`, `href?`, `isActive?`, `isDisabled?`, `rightElement?`, `variant?: 'default'|'subItem'`, `as?`, `onClick`
  - `VerticalNavigation.Footer` (holds Settings and Documentation)
  - `VerticalNavigation.Collapse` (the Navigation template says not to use it)

**`TabNav`** (`:2239-2280`)
- `items: {key; name; href?; icon?: ReactNode; disabled?; subItems?; 'aria-label'?}[]`
- `activeKey`, `onTabPress(key)`, `tabPlacement?: 'horizontal'|'vertical'`, `tabBarExtraSlot`, `centered`, `wrap`
- Tabs are **links** and use `RouterProvider` for client-side routing.

**`Breadcrumbs`** + **`Breadcrumb`** (`:1705-1738`): `size`, `shouldEmpasizeCurrent` (the name is misspelled in the source). The last crumb has no `href`.
**`Pagination`** (`:1676-1694`): `total`, `current` (1-based), `pageSize` (default 10), `onChange(page, pageSize)`, `'aria-label'` (required).
**`TopNav`** (`:2283-2321`): `TopNav.Start|Center|End`. INFERRED: do not use it inside a Cribl App, because the shell already provides the header (see the Overview template's "Layout law").
**`Tree`** (`:2477-2553`): `items: {key; label; children?; isDisabled?; suffix?; trailingSlot?}[]`, `selectionMode?: 'none'|'multiple'`, expanded and selected keys as `Set<Key>`, `onAction(key)`.
**`RouterProvider`**: re-exported from `react-aria-components` (`index.d.mts:4`). See §8.1.

---

## 4. Callback signature table (a common copy-paste trap)

| Component | Change callback | Value shape |
|---|---|---|
| `TextField`, `PasswordField`, `TextArea`, `AutocompleteField` | `onChange` | `(value: string)` |
| `NumberField` | `onChange` | `(value: number)`, unformatted |
| `SelectField` single / multiple | `onChange` | `(Key \| null)` / `(Set<Key>)` |
| `Checkbox`, `Switch`, `Radio`, `RadioGroup` | `onChange` | **native `ChangeEvent<HTMLInputElement>`** |
| `ToggleButtonGroup` | `onSelectionChange` | `(Set<Key>)` |
| `Table` | `onSelectionChange` / `onSortChange` | `(Selection)` / `(SortDescriptor)` from react-aria |
| `Tree` | `onSelectionChange` / `onExpandedChange` / `onAction` | `(Set<Key>)` / `(Set<Key>)` / `(Key)` |
| `Collapse` / `CollapseGroup` | `onExpandedChange` | `(isExpanded: boolean)` / `(Set<Key>)` |
| `Modal` | **`onIsOpenChange`** | `(open: boolean)` |
| `Drawer` | `onOpenChange` + `onClose` | `(isOpen)` / `(event?)` |
| `Popover`, `SelectField`, `AutocompleteField` | `onOpenChange` | `(isOpen: boolean)` |
| `Menu` | `onOpenChange` (open state prop is `open`, not `isOpen`) | `(open: boolean)` |
| `Menu.Item`, `TabNav` sub-items | `onPress` (`onClick` deprecated) | `(PressEvent)` / `()` |
| `TabNav` | `onTabPress` | `(key: string)` |
| `Pagination` | `onChange` | `(page: number, pageSize: number)` |
| `Button`, `IconButton` | `onClick` **or** `onPress` | native `MouseEvent` / react-aria `PressEvent` |
| `Alert.action`, `Toast` action | `onClick` | `(e: MouseEvent<HTMLButtonElement>)` |

Disabled-prop spelling also varies:
- `disabled`: Button, IconButton, fields, SelectField, Pagination, ToggleButtonGroup, Menu.Item.
- `isDisabled`: VerticalNavigation.Item, Tooltip, Collapse, Tree items, Anchor.

---

## 5. Icon prop shapes (the second trap)

| Takes the **component** (`SvgIcon`): `leadingIcon={Cog}` | Takes an **element** (`ReactNode`): `icon={<Cog />}` |
|---|---|
| `Button.leadingIcon/trailingIcon`, `ButtonLink.*Icon`, `IconButton.icon`, `Tag.icon` (also `SvgLogo`), `Ribbon.*Icon`, `SelectField` item `.icon`, `ToggleButtonGroup` item `.icon` | `VerticalNavigation.Item.icon`, `TabNav` item `.icon`, `Menu.Item.icon`, `RadioTile.icon`, `Pill.icon` |

---

## 6. `@capra/icons`

Entry points (`node_modules/@capra/icons/package.json`):
- `@capra/icons`: 330 icons
- `@capra/icons/images`: empty-state illustrations
- `@capra/icons/logos`: vendor and product logos
- `@capra/icons/styles.css`
- Per-file deep imports: `@capra/icons/esm/icons/<Name>`

Icon props (`node_modules/@capra/icons/dist/utils/factory.d.mts:3-13`):
- `size?: 'xs'|'sm'|'md'|'lg'|'xl'`. The sizes map to `dimension.icon.*` = 12/16/24/32/48 px.
- Plus SVG props. `className` is omitted.
- Inside Capra buttons, icons render at `size="sm"` automatically (`index.mjs:123,145`).

```ts
import { ArrowTrendUp, ArrowTrendDown, CheckOutlined, WarningOutlined, InfoOutlined, Cog, ReloadOutlined,
         CopyOutlined, ArrowUpRightFromSquare, Pipeline, Routes, Destinations, Sources } from '@capra/icons';
import { EmptyFolder, EmptyFolderDark } from '@capra/icons/images';
import { Splunk, Datadog, AwsS3, Snowflake } from '@capra/icons/logos'; // NOT '@capra/logos'
```

Relevant icon names, all verified in `node_modules/@capra/icons/dist/icons.d.mts`:

| Need | Icon names |
|---|---|
| Arrows / trend | `ArrowUp ArrowDown ArrowLeft ArrowRight ArrowTrendUp ArrowTrendDown ArrowTurnDownLeft AnglesLeft AnglesRight ChevronUp ChevronDown ChevronLeft ChevronRight CaretUp CaretDown CaretRight CaretUpSolid CaretDownSolid CaretLeftSolid CaretRightSolid SwapOutlined SwapRightOutlined RightOutlined LeftChevron` |
| Check / success | `Check CheckOutlined CircleCheck CircleCheckFilled CircleCheckSolid SuccessOutlined SuccessSolid BadgeCheck` |
| Warning | `WarningOutlined WarningSolid TriangleExclamation TriangleExclamationSolid SquareExclamation SquareExclamationSolid Exclamation` |
| Error / danger | `AttentionOutlined AttentionSolid CircleExclamation CircleXmark CircleXmarkSolid CircleXFilled AlertOutlined Ban` |
| Info / help | `InfoOutlined InfoSolid CircleInfo CircleInfoSolid HelpOutlined QuestionCircle QuestionCircleOutlined CircleQuestion Lightbulb` |
| Money (no `$` glyph) | none named dollar/money/currency. Nearest: `Token Gauge GaugeSimple GaugeSimpleHigh GaugeSimpleLow GaugeSimpleMiddle Metrics ChartLine ChartBar ChartColumn ChartArea ChartPie ChartDonut Trophy BagShopping CartShopping` |
| Settings | `Cog CustomSettings Sliders SlidersUp ToolOutlined` |
| Play / pause / media | `Play Pause Forward ForwardStep Backward BackwardStep CircleStopSolid` |
| Refresh / loading | `Reload ReloadOutlined Loading SpinnerThird HistoryOutlined ClockOutlined` |
| Copy / clipboard | `Copy CopyOutlined Paste` |
| External link | `ArrowUpRightFromSquare Share Link LinkOutlined LinkSlash` |
| Flow / Cribl domain | `Pipeline Routes Destinations Sources Stream Edge Lake Lakehouse Packs QuickConnect DiagramSankey PartitionOutlined NodesOutlined WorkersOutlined FleetOutlined DataInsights Insights SystemInsights Outbound Outposts MappingOutlined BranchesOutlined Database DatabaseOutlined HardDrive StorageFilled CriblOutlined Copilot Goat` |
| Navigation template | `HomeOutlined` (first item), `Cog` (Settings), `Book` (Documentation) |
| Misc actions | `Plus Minus EditOutlined DeleteOutlined Trash CloseOutlined Download Upload Filter FilterOutlined Search SearchOutlined Ellipsis EllipsisVertical Eye EyeOutlined EyeInvisibleOutlined BellOutlined Bolt Fire Flag Star StarSolid Lock Table TableOutlined DashboardOutlined CalendarOutlined` |

Images (`node_modules/@capra/icons/dist/images.d.mts`):
- Every illustration has a light and a `*Dark` variant: `ArtSupplies Attention Celebration EmptyBowl EmptyFolder EmptySuitcase Envelope Hibernating MissingSock PizzaBox PottedPlant Sandcastle`.
- `size?: 'sm'|'md'|'lg'`.
- The original scaffold `src/App.tsx` used `<EmptySuitcase size="lg" />`. That file has since been replaced in this repo, so there is no current line to cite.

Logos (`node_modules/@capra/icons/dist/logos.d.mts`, 131 logos). Destinations relevant to Meter Reader include:
`Splunk Datadog Elastic ElasticCloud ElasticSearch Snowflake NewRelic SumoLogic Dynatrace Honeycomb Grafana Loki Prometheus Clickhouse Exabeam Devo Qradar SentinelOne Crowdstrike MsAzureSentinel MsAzureDataExplorer MsAzureBlobs MsAzureEventHubs MsAzureMonitor AwsS3 AwsSecurityLake AwsCloudwatch AwsKinesis AwsDataFirehose GcpStorage GcpPubsub GoogleCloudLogging ApacheKafka Confluent OpenTelemetry Ocsf GenericDatalake GenericDevNull GenericHttp GenericSyslog LakeColor StreamColor EdgeColor SearchColor InsightsColor CopilotColor`.

---

## 7. `@capra/theme` tokens (`token('…')`)

There are 1,727 token keys in total, grouped as 363 `color.*`, 216 `visualization.*`, 966 `core.*`, 88 `brand.*`, and the rest. The full union is `TokenName` in `node_modules/@capra/theme/dist/tokens-minimal-BmQxVNAw.d.mts`. Descriptions and light values are in `node_modules/@capra/theme/docs/foundation-design-tokens-reference--docs.md`. According to `:706-708`, `core.*` and `brand.*` "are utilized by the semantic layers and are not intended to be used directly".

### 7.1 Color, semantic (light values shown; dark re-resolves via `.dark`)

Descriptions come from the reference doc at `:9-162`.

**Foreground**

| Token | Use |
|---|---|
| `color.foreground.default` `#1c2024` | primary text and icons |
| `color.foreground.subtle` `#60646c` | secondary and helper text |
| `color.foreground.disabled`, `.onDisabled`, `.placeholder` | disabled text and placeholders |
| `color.foreground.link` `#0072de` | links |
| `color.foreground.{neutral,accent,danger,warning,success,info,highlight,brand}.{default,strong,contrast}` | `default` on tinted backgrounds; `strong` for high contrast; `contrast` on `.solid` fills |

Examples: `success.default` = `#00824d`, `danger.default` = `#ce2c31`, `warning.default` = `#ad6200`.

**Background**

| Token | Use |
|---|---|
| `color.background.application` | the root page canvas only |
| `color.background.panel.solid` | cards, menus, modals |
| `color.background.panel.translucent` | glass-style panels |
| `color.background.surface` | form controls |
| `color.background.scrim` | overlays |
| `color.background.disabled` | disabled controls |
| `color.background.{neutral,accent,danger,warning,success,info}.{subtle,default,hover,selected,surface,indicator,track}` and `.solid.{default,hover,active}` | tinted surfaces and states |
| `color.background.{highlight,brand}.{subtle,default,hover}` + `.solid.{default,hover}` | highlight has `selected/surface/indicator/track` too; brand does not |

- `neutral.subtle` suits zebra rows and subtle grouping.
- `.solid.*` fills pair with `color.foreground.*.contrast`.
- `indicator` and `track` are meant for checkbox, radio, progress and slider parts.

**Border**

| Token | Use |
|---|---|
| `color.border.neutral.{default,subtle,strong}` | inputs, cards, dividers |
| `color.border.{accent,danger}.{default,subtle,strong,hover}` | danger also has `.focus` |
| `color.border.{warning,success,info,highlight,brand}.{default,subtle,strong}` | intent borders |
| `color.border.focus`, `color.border.disabled` | focus and disabled |

**Raw scales** (Radix-style): `color.{neutral,accent,danger,warning,success,info,highlight,brand}.{1..12, A1..A12, contrast, surface, indicator, track}`. Prefer the semantic tokens above.

Intent → scale mapping. Verified: `--cds2-color-<intent>-9` resolves to a core scale in the `base.css` `:root` block:
- `accent` and `info` = blue
- `neutral` = slate
- `danger` = red
- `success` = green
- `warning` = amber
- `highlight` = purple
- `brand` = Cribl teal

### 7.2 Non-colour tokens (values from the reference doc, `:576-705`)

| Group | Keys → value |
|---|---|
| Spacing | `spacing.none` 0, `.xs` 2px, `.sm` 4px, `.md` 8px, `.lg` 16px, `.xl` 24px, `.2xl` 32px |
| Radius | `radius.md` 2px (default), `.lg` 4px (focus ring), `.xl` 8px, `.full` 9999px |
| Border (shorthand) | `border.default` = `1px solid border.neutral.default`; `border.focus` = `2px solid border.focus`; `border.badge` |
| Shadow | `shadow.{low,medium,high}.{up,down,left,right}`, `shadow.button`, `shadow.wave`. Low: hover and drag. Medium: dropdowns and popovers. High: dialogs (`docs/foundation-shadows--docs.md`) |
| Component height | `dimension.component.xs` 16, `.sm` 24, `.md` 32 (default control), `.lg` 40, `.xl` 48 |
| Icon | `dimension.icon.xs` 12, `.sm` 16, `.md` 24, `.lg` 32, `.xl` 48 |
| Modal | `dimension.modal.sm` 544, `.md` 864, `.lg` 1184 |
| Motion | `motion.duration.instant` 10ms, `.short` 100ms, `.medium.1` 200ms, `.medium.2` 300ms, `.long.3` 1000ms; `motion.easing.standard`, `motion.easing.wave` |
| Other | `opacity.state.disabled`, `breakpoint.md`, `temporary.input.*` (8 keys; the name suggests they are temporary, so avoid them) |

**Typography** (the `font` shorthand; use it as `font: token('typography.metric.xl')`):

| Token | Value |
|---|---|
| `typography.heading.xs` | 600 14px/1.43 |
| `typography.heading.sm` | 600 16px/1.5 |
| `typography.heading.md` | 600 20px/1.2 (the most common h2) |
| `typography.heading.lg` | 600 24px (page title, once per page) |
| `typography.heading.xl` | 600 30px |
| `typography.body.xs` | 10px |
| `typography.body.sm` | 12px |
| `typography.body.md` | 14px/1.71 (default) |
| `typography.body.lg` | 16px |
| `typography.metric.sm` | 600 16px |
| `typography.metric.md` | 600 24px |
| `typography.metric.lg` | 600 36px |
| `typography.metric.xl` | 600 48px/1 (hero KPI) |
| `typography.code` | 400 14px 'Source Code Pro' |

- The body tokens come in `.normal` (400) and `.semibold` (600) variants.
- Every typography token has a `.letterSpacing` sibling.
- Font family: 'Open Sans', sans-serif.
- Source: `node_modules/@capra/theme/docs/foundation-typography--docs.md`.

Core typography values, when needed: `core.fontFamily.{sans,mono}`, `core.fontSize.{xxs,xs,body,md,lg,xl,2xl,3xl,4xl,5xl}`, `core.fontWeight.{thin..black}`, `core.lineHeight.*`.

### 7.3 Data viz

The palettes do **not** change between light and dark mode. Only chart chrome such as axes and tooltips changes (`docs/foundation-design-tokens-visualization--docs.md`).

| Palette type | Tokens |
|---|---|
| Categorical | `visualization.categorical.observable10.{1..10}` (1 = `#4269d0`, 2 = `#efb118`, …), `.tableau10.{1..10}`, `.set2.{1..8}`, `.paired.{1..12}` |
| Diverging | `visualization.diverging.{RdYlBu,PuOr,Spectral}.{1..11}` |
| Sequential | `visualization.sequential.{Blues,Greens,Oranges,Purples,Reds,Greys,Cool,Warm,Magma,Plasma,Inferno,Viridis,Cividis}.*` |
| Consistent (named colours) | `visualization.consistent.{Blue,Green,Red,Amber,Teal,Purple,…}`. **`visualization.consistent.Cribl Teal` contains a space**, so quote it exactly |

For SVG charts, set `fill`/`stroke` from CSS classes with `token('visualization.categorical.observable10.1')`. The chart chrome should use the semantic tokens.

For canvas renderers or ECharts (`node_modules/@capra/theme/dist/visualizations.d.mts`):

```ts
import { getChartTheme, getEchartsTheme, visualizationPaletteNames } from '@capra/theme/visualizations';
const t = getChartTheme({ palette: 'categorical.observable10', mode: theme }); // theme from installThemeBridge onTheme
// t.palette: string[] (hex), t.backgroundColor, t.textColor, t.axisLabelColor, t.splitLineColor, t.tooltipBackgroundColor, ...
```

`getChartTheme` accepts the palette names `categorical.*`, `diverging.*`, `sequential.*` and `'consistent'`. **No chart library is installed** (`ls node_modules` shows no echarts, recharts or chart.js). The executive-dashboard reference app hand-rolls SVG charts (`ref/cc-cribl-executive-dashboard/src/styles/viz.css`).

### 7.4 Content formatting rules (`node_modules/@capra/theme/docs/foundation-content-numbers--docs.md`)

- **Currency** (`:3-28`):
  - Show the symbol, thousands commas and **two decimals**.
  - No space after the symbol (`$10.20`).
  - Append `USD` only when comparing currencies.
- **Decimals** (`:46-49`): round to hundredths.
- **Units** (`:51-80`):
  - Put a space between the number and the unit (`2.7 GB`).
  - Step up to the next unit above 1,000.
  - Never mix units within one column; the Tables template says the same.
- **Dates:** see `docs/foundation-content-date-time--docs.md`.
  - Relative times: "just now", "# minutes ago", "# hours ago", then a date stamp.
  - Absolute dates: "Sep 17, 2019" in the short form.
  - Table columns: a numeric locale-specific format.

---

## 8. Patterns from shipped reference apps

Capra versions in the reference apps: `cc-visicore-spl-to-kql` uses `^1.15.0`, `cc-firewall-monitor` `^1.14.0`, `cc-edge-tag-monitoring` `^1.13.0`, the executive dashboard and power-tools `^1.11.1`, lookup-sync `^1.9.0`, `cc-gigamon-ami` `^1.8.2`. These come from each repo's `package.json`. Several of them predate `Table` (1.14) and the current AGENTS.md theming rules.

### 8.1 Router integration (`ref/cc-di-data-flow-monitor/src/App.tsx:2-3,20-24,135`)

```tsx
import { BrowserRouter, Routes, Route, useNavigate, useHref, type NavigateOptions } from 'react-router-dom';
import { RouterProvider } from '@capra/core';
declare module '@capra/core' { interface RouterConfig { routerOptions: NavigateOptions } }

function Shell() {
  const navigate = useNavigate();
  return (
    <RouterProvider navigate={navigate} useHref={useHref}>   {/* useHref applies basename to rendered hrefs */}
      <Routes>{/* … */}</Routes>
    </RouterProvider>
  );
}
// root: <BrowserRouter basename={window.CRIBL_BASE_PATH}><Shell /></BrowserRouter>   (AGENTS.md:326-332)
```

- `cc-edge-tag-monitoring` omits `useHref` (`ref/cc-edge-tag-monitoring/src/components/AppShell.tsx:19`). INFERRED: its rendered `href`s then lack the base path, so middle-click and "open in new tab" break. Pass `useHref`, as the Capra conventions doc recommends (`docs/conventions--docs.md`, React Router section).
- `TabNav` with RouterProvider: `ref/cc-edge-tag-monitoring/src/components/AppShell.tsx:7-11,30`.

### 8.2 `VerticalNavigation` with react-router (`ref/cc-di-data-flow-monitor/src/components/Sidebar.tsx:68-76,92-147`)

`VerticalNavigation.Item` renders a plain `<a href>` or `<button>` (`node_modules/@capra/core/dist/index.mjs:3815-3852`), so `RouterProvider` never reaches it. Intercept the click:

```tsx
const navigate = useNavigate(); const { pathname } = useLocation();
const go = (href: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(href); };
<VerticalNavigation aria-label="Meter Reader navigation">
  <VerticalNavigation.ItemList>
    <VerticalNavigation.Item icon={<HomeOutlined />} label="Overview" href="/" isActive={pathname === '/'} onClick={go('/')} />
  </VerticalNavigation.ItemList>
  <VerticalNavigation.Footer>
    <VerticalNavigation.Item icon={<Cog />} label="Settings" href="/settings" isActive={pathname === '/settings'} onClick={go('/settings')} />
    {/* INFERRED: extra anchor attributes such as target="_blank" pass through ...restProps (index.mjs:3815-3852), but no reference app does this; verify in installed mode */}
    <VerticalNavigation.Item icon={<Book />} label="Documentation" href="https://docs.cribl.io/apps" target="_blank" />
  </VerticalNavigation.Footer>
</VerticalNavigation>
```

- Keep the JSX tree shape stable when you wrap items in a `Tooltip`. Toggle `isDisabled` rather than swapping between trees, or CSS transitions snap (`Sidebar.tsx:108-125`).

### 8.3 KPI / metric tile (`ref/cc-cribl-executive-dashboard/src/components/StatTile.tsx:16-17,50-83`)

- Label: `Text variant="body-sm-normal" color="secondary"`.
- Value: `Text variant="metric-lg" as="p"`.
- Trend: `ArrowTrendUp`/`ArrowTrendDown`/`Minus` at `size="sm"`, plus a text label, so that direction is never carried by colour alone.
- Wrapping the value lets you colour it through a parent class, and `Text` inherits that colour (`:59-65`).
- A FinOps credits card that combines `Card.Header/Title/Description/Content` with an `Alert` holding an `action` and an `isExternal` `Link` is at `ref/cc-cribl-executive-dashboard/src/panels/CreditsPanel.tsx:52-74`. It uses the loading state `Spinner` plus a secondary `Text` (`:109-118`).
- Also `ref/cc-di-data-flow-monitor/src/components/Overview/KpiRow.tsx:96` (`variant="metric-sm"`).

### 8.4 Toast (`ref/cc-gigamon-ami/src/components/Toast.tsx:44-113`)

- Mount `<Toast.Provider />` once, beside `<App/>`.
- Keep the returned id so you can `Toast.destroy(id)` a sticky progress toast.
- Errors use `{ duration: 0 }`, which makes them sticky.

### 8.5 Confirm before a destructive action

See §3.7 for the `Modal.confirm` code and the reference usage.

### 8.6 Page layout (the Capra page templates, fetched from capra.cribl.io)

- `llms/foundation-page-templates-overview--docs.txt`, the "Layout law":
  1. The shell is PROVIDED.
  2. The left nav MUST be `VerticalNavigation`.
  3. The main content uses a 12-column grid.
  4. Modules are placed with `grid-column: span N`.
  - Common spans: 3 (KPI), 4 (wide KPI), 6 (half), 12 (full). Do not add filler modules.
- The first screen answers three questions: "What changed? Is anything wrong? What should I do next?"
- The optional modules map to components as follows: KPI = Card + metric; Chart = Card with `Card.Title` and actions in `Card.Action`; Notice = Alert; Empty = EmptyState; Loading = Skeleton; Status = Badge/Pill; TimeScope = a date-range picker in the page header.
- `…-tables--docs.txt`: at most 4 metric cards in the first row. After that the full-width `Table` sorts by the primary column ascending by default, and loading shows 5 skeleton rows.
- `…-setup-config--docs.txt`: 3 to 5 setup steps with a Stepper. The Stepper is **not exported**, so build it from Buttons. Buttons on the far right are Cancel (secondary) then Save (primary), with inline validation.
- `…-navigation--docs.txt`:
  - Put "Overview"/`HomeOutlined` first.
  - Put "Settings" (`Cog`) and "Documentation" (`Book`) in the bottom container.
  - Keep labels to 1 to 2 words.
  - Do not add logos to the nav, and do not add `display` rules to its container.

```css
.page-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: token('spacing.lg');
  padding-inline: token('spacing.lg');
}
.span-3 { grid-column: span 3; } .span-4 { grid-column: span 4; } .span-6 { grid-column: span 6; } .span-12 { grid-column: span 12; }
```

### 8.7 Anti-patterns in reference apps (they violate the current AGENTS.md, so do not copy them)

| What | Where |
|---|---|
| Own theme toggle, or `prefers-color-scheme` as the source of truth | `ref/cc-di-data-flow-monitor/src/lib/theme.ts:4-19`, `ref/cc-gigamon-ami/src/app/theme.ts:30-39`, `ref/cc-visicore-lake-credit-usage/src/App.tsx:65` |
| Forcing `.dark` on `<html>` | `ref/cc-cribl-executive-dashboard/src/main.tsx:21` |
| Overriding `--cds2-*` variables directly | `ref/cc-cribl-power-tools/src/App.css:37`; `ref/cc-gigamon-ami/src/App.css:185` (`:root.dark`) |
| Targeting Capra-internal classes such as `.capra-VerticalNavigation-module-*` or `.capra-Drawer-module-*` | `ref/cc-di-data-flow-monitor/src/App.tsx:106-109,125-129` |
| Hard-coded colours, including the scaffold's own `.text-green { color: #52c41a; }` | `src/App.css:38-40`. Replace it with `token('color.foreground.success.default')` |

---

## 9. Where Capra's own docs are wrong or misleading (verified against 1.16.0 code)

| Doc says | Reality |
|---|---|
| The Navigation template says to use "`@capra-ui/core/VerticalNavigation`" | The package is `@capra/core` |
| The templates require `@capra/PageHeader`, Stepper, TimeScope, MetricCard, InsightBanner, "BateRangePicker" | None of these is exported. The date-range component is `DateRangePickerField` |
| The Card design doc lists `shape.border.default` and `shape.radius.xl`; the reference doc's `color.border.focus` entry mentions `shape.border.focus` | The real keys are `border.default`, `radius.xl` and `border.focus`, with no `shape.` prefix. The Card's actual CSS uses `radius.md` |
| The Card design doc says titles are wrapped in an `h2` by default | `Card.Title` renders `Text`, which is a `<span>`; pass `as="h2"` (`index.mjs:487-497`) |
| The Overview template mentions `foreground.primary` / `foreground.subtle` | There is no `color.foreground.primary`. Use `color.foreground.default` (Text `color="primary"` maps to it) |
| The Table usage doc uses `<TableToolbar>` and omits the `defineColumns` import | The export is `FilterToolbar`. Import `defineColumns` from `@capra/core` |
| The Toast usage page documents an inline `Toast` component with `type`/`content` | That page describes a docs-preview component; the docs themselves say "Not for use in production". Use `Toast.Provider` plus `Toast.success/error/info/warning` |
| The Tokens Usage doc imports `allTokens` from `'@capra/tokens/dx/tokens-minimal.ts'` | Use `'@capra/theme/dx/tokens-minimal'`, as `.postcssrc.mjs:2` does |
| The Button design doc says "three sizes" | There are five: `xs sm md lg xl` (`index.d.mts:1298`) |
| The Navigation template says not to use the collapse button | `VerticalNavigation.Collapse` exists. Follow the template and omit it |
