// Icon rail (fixed width, no resize)
export const ICON_RAIL_WIDTH = 48;

// Project tree panel size constraints
export const PROJECT_TREE_WIDTH_DEFAULT = 220;
export const PROJECT_TREE_WIDTH_MIN = 160;
export const PROJECT_TREE_WIDTH_MAX = 400;

// Bottom panel size constraints
export const BOTTOM_PANEL_HEIGHT_DEFAULT = 240;
export const BOTTOM_PANEL_HEIGHT_MIN = 120;
export const BOTTOM_PANEL_HEIGHT_MAX = 500;

// Responsive breakpoint (px). Below this width the layout collapses the side
// and bottom panels (see workspace.css). The expanded workbench mode also
// degrades back to docked here — two panes side by side are both too cramped
// under this width, so degrading beats crowding.
export const RESPONSIVE_COLLAPSE_BREAKPOINT = 720;

// Agent panel size constraints (docked mode — fixed-width side panel)
export const AGENT_PANEL_WIDTH_DEFAULT = 360;
export const AGENT_PANEL_WIDTH_MIN = 280;
export const AGENT_PANEL_WIDTH_MAX = 600;

