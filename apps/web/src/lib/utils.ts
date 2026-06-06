// Tailwind-free className joiner. This project styles with a custom stylesheet
// (styles.css), not Tailwind utilities, so cn() just concatenates truthy class
// strings. React Bits Pro components import { cn } from "@/lib/utils"; this
// satisfies that import without pulling in clsx / tailwind-merge.
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}
