import { useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Shared collapsible primitive (Story 3.5 Step 7, design §5.2).
 *
 * Extracted from the four existing expand/collapse idioms in the agent panel
 * (AgentToolCard / ChildExecutionGroup / work-steps header / DiffCard — see
 * the adoption notes in each). The component renders exactly the DOM those
 * sites rendered by hand:
 *
 *   <div class=className>
 *     <button class=headerClassName> [chevron] header [chevron] </button>
 *     {open && <div class=bodyClassName>{children}</div>}
 *   </div>
 *
 * so adopting it is a pure UI merge with zero behavior change. Two modes:
 * - Uncontrolled: pass `defaultOpen` (defaults to false) — internal state.
 * - Controlled: pass `open` + `onToggle` (e.g. BatchGroup keeps the folded
 *   state in panelsSlice so project resets can clear it).
 *
 * The chevron is a Material Symbols span; position ('start' | 'end') and the
 * icon pair are caller-owned because the existing sites differ deliberately
 * (tool cards use expand_less/expand_more at the end, child groups and work
 * steps use expand_more/chevron_right — the "rotating" idiom — at the end or
 * start respectively). `chevron="none"` omits it entirely.
 */
export type CollapsibleProps = {
  /** Uncontrolled initial state (controlled callers pass `open` instead). */
  defaultOpen?: boolean;
  /** Controlled open value; when set, the component no longer keeps local state. */
  open?: boolean;
  /** Fired on toggle with the NEXT state (controlled callers persist it). */
  onToggle?: (next: boolean) => void;
  /** Outer wrapper class. */
  className?: string;
  /** Style pass-through for the outer wrapper (e.g. CSS custom properties). */
  style?: CSSProperties;
  /** Header row class — the header renders as a <button>. */
  headerClassName?: string;
  /** Body wrapper class (rendered only while open). */
  bodyClassName?: string;
  /** Where the chevron span sits within the header row. */
  chevron?: 'start' | 'end' | 'none';
  /** Material Symbols names for the open / closed states. */
  chevronIcons?: { open: string; closed: string };
  /** Extra class for the chevron span (after `material-symbols-outlined`). */
  chevronClassName?: string;
  /** Header contents (everything except the chevron). */
  header: ReactNode;
  /** Body contents — rendered only while open. */
  children: ReactNode;
};

export function Collapsible({
  defaultOpen = false,
  open,
  onToggle,
  className,
  style,
  headerClassName,
  bodyClassName,
  chevron = 'end',
  chevronIcons = { open: 'expand_less', closed: 'expand_more' },
  chevronClassName,
  header,
  children,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  const toggle = () => {
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onToggle?.(next);
  };

  const chevronNode = chevron === 'none' ? null : (
    <span className={`material-symbols-outlined${chevronClassName ? ` ${chevronClassName}` : ''}`} aria-hidden="true">
      {isOpen ? chevronIcons.open : chevronIcons.closed}
    </span>
  );

  return (
    <div className={className} style={style}>
      <button type="button" className={headerClassName} onClick={toggle} aria-expanded={isOpen}>
        {chevron === 'start' && chevronNode}
        {header}
        {chevron === 'end' && chevronNode}
      </button>
      {isOpen && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}
