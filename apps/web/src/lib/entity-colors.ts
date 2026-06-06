// Single source of truth for entity-type → colour/label/order, shared by the
// Facts panel legend (main.tsx) and the 3D knowledge-graph constellation so the
// graph and the legend can never disagree. Keep the hex values in sync with the
// .factsType-* swatches in styles.css.

export type EntityType =
  | "organization"
  | "product"
  | "feature"
  | "person"
  | "technology"
  | "integration"
  | "platform"
  | "pricing_plan"
  | "use_case"
  | "metric"
  | "customer"
  | "competitor"
  | "location"
  | "event"
  | "concept"
  | "other";

// Refined categorical palette: Radix dark step-9 hues (tuned for near-black, with
// consistent perceptual lightness so no single hue screams neon), with concept/other
// kept as muted neutrals so background types stay recessive. Replaces the old
// mixed-saturation primaries that read "gamer/crypto". Keep .factsType-* in styles.css in sync.
export const ENTITY_TYPE_COLORS: Record<EntityType, string> = {
  organization: "#3e7bd6",
  product: "#46a758",
  platform: "#12a594",
  feature: "#8e4ec6",
  technology: "#3aa6c4",
  integration: "#e07b3c",
  pricing_plan: "#29a383",
  use_case: "#cf5b9b",
  person: "#dd6a52",
  customer: "#5b7fd6",
  competitor: "#d65b5f",
  metric: "#d6b150",
  location: "#6b6bcf",
  event: "#d65b8a",
  concept: "#8b97a8",
  other: "#6e7079",
};

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  organization: "Organizations",
  product: "Products",
  feature: "Features",
  person: "People",
  technology: "Technologies",
  integration: "Integrations",
  platform: "Platforms",
  pricing_plan: "Pricing plans",
  use_case: "Use cases",
  metric: "Metrics",
  customer: "Customers",
  competitor: "Competitors",
  location: "Locations",
  event: "Events",
  concept: "Concepts",
  other: "Other",
};

export const ENTITY_TYPE_ORDER: EntityType[] = [
  "organization",
  "product",
  "platform",
  "feature",
  "technology",
  "integration",
  "pricing_plan",
  "use_case",
  "person",
  "customer",
  "competitor",
  "metric",
  "location",
  "event",
  "concept",
  "other",
];

// Resolve any entity-type string (graph nodes carry the raw type) to its colour,
// falling back to the neutral "other" swatch for unknown types.
export function colorForType(type: string): string {
  return ENTITY_TYPE_COLORS[type as EntityType] ?? ENTITY_TYPE_COLORS.other;
}

export function labelForType(type: string): string {
  return ENTITY_TYPE_LABELS[type as EntityType] ?? type;
}
