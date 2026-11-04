import { t } from "./i18n";

// Required marks a field the form cannot go on without; the field itself carries aria-required.
export function Required() {
  return (
    <span class="req" title={t("Required")} aria-hidden="true">
      *
    </span>
  );
}

// RequiredLegend explains the mark, for the longer forms.
export function RequiredLegend() {
  return (
    <span class="req-legend" data-testid="required-legend">
      <span class="req" aria-hidden="true">
        *
      </span>{" "}
      {t("required")}
    </span>
  );
}

// Missing says what a form still waits for, next to its disabled button: a tooltip is not seen
// on a phone.
export function Missing({ items }: { items: (string | false | null | undefined)[] }) {
  const left = items.filter(Boolean) as string[];
  if (!left.length) {
    return null;
  }
  return (
    <p class="missing" role="status" data-testid="missing">
      {t("Still needed: {items}", { items: left.join(", ") })}
    </p>
  );
}
