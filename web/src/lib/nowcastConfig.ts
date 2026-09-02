/**
 * Manual release gate for ward-level nowcasting (+1h). Flipped to `true`
 * only after `docs/data/nowcast-shadow-review.md`'s pre-registered numeric
 * criteria are met against real `nowcast_shadow_log` data - not a
 * subjective call made after looking at the numbers.
 *
 * Checked in two places, not just one: MapToolbar.tsx (hides the toolbar
 * button) and GeoAiPanel.tsx's action executor (hiding the toolbar button
 * alone doesn't stop GeoAI independently emitting a set_time action with
 * time_mode: '1h').
 */
export const NOWCAST_FEATURE_ENABLED = false
