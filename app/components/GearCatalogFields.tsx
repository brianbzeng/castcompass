"use client";

import { KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import {
  findCatalogProduct,
  gearBrands,
  gearProducts,
  type GearCatalogKind,
  type GearCatalogProduct,
} from "../data/gear-catalog";

export interface GearFieldValues {
  rod: string;
  reel: string;
  baitLure: string;
  rig: string;
}

interface GearCatalogFieldsProps {
  values: GearFieldValues;
  onChange(values: GearFieldValues): void;
  className?: string;
}

interface Choice {
  id: string;
  label: string;
  detail?: string;
}

const OTHER = "__other__";

export function GearCatalogFields({ values, onChange, className = "" }: GearCatalogFieldsProps) {
  const [brandOverrides, setBrandOverrides] = useState<Record<GearCatalogKind, string>>(() => ({
    rod: findCatalogProduct("rod", values.rod)?.brand ?? "",
    reel: findCatalogProduct("reel", values.reel)?.brand ?? "",
    lure: findCatalogProduct("lure", values.baitLure)?.brand ?? "",
  }));
  const brands = {
    rod: findCatalogProduct("rod", values.rod)?.brand ?? (values.rod ? OTHER : brandOverrides.rod),
    reel: findCatalogProduct("reel", values.reel)?.brand ?? (values.reel ? OTHER : brandOverrides.reel),
    lure: findCatalogProduct("lure", values.baitLure)?.brand ?? (values.baitLure ? OTHER : brandOverrides.lure),
  };

  const updateValue = (key: keyof GearFieldValues, value: string) => onChange({ ...values, [key]: value });

  return (
    <div className={`gear-catalog-fields ${className}`.trim()}>
      <CatalogRow
        kind="rod"
        label="Rod"
        value={values.rod}
        brand={brands.rod}
        onBrandChange={(brand) => {
          setBrandOverrides((current) => ({ ...current, rod: brand }));
          updateValue("rod", "");
        }}
        onValueChange={(value) => updateValue("rod", value)}
      />
      <CatalogRow
        kind="reel"
        label="Reel"
        value={values.reel}
        brand={brands.reel}
        onBrandChange={(brand) => {
          setBrandOverrides((current) => ({ ...current, reel: brand }));
          updateValue("reel", "");
        }}
        onValueChange={(value) => updateValue("reel", value)}
      />
      <CatalogRow
        kind="lure"
        label="Lure"
        value={values.baitLure}
        brand={brands.lure}
        onBrandChange={(brand) => {
          setBrandOverrides((current) => ({ ...current, lure: brand }));
          updateValue("baitLure", "");
        }}
        onValueChange={(value) => updateValue("baitLure", value)}
      />
      <div className="gear-manual-row">
        <label className="trip-field">
          <span>Bait or unlisted lure <em>optional</em></span>
          <input
            maxLength={200}
            value={values.baitLure}
            onChange={(event) => {
              setBrandOverrides((current) => ({ ...current, lure: OTHER }));
              updateValue("baitLure", event.target.value);
            }}
            placeholder="Shrimp, anchovy, custom lure…"
          />
        </label>
        <label className="trip-field">
          <span>Rig tied <em>optional</em></span>
          <input maxLength={200} value={values.rig} onChange={(event) => updateValue("rig", event.target.value)} placeholder="Dropshot, Carolina rig…" />
        </label>
      </div>
      <small className="gear-catalog-note">Can’t find it? Choose “Other / not listed” and type the exact setup. The catalog focuses on common Bay Area inshore and surf gear.</small>
    </div>
  );
}

function CatalogRow({
  kind,
  label,
  value,
  brand,
  onBrandChange,
  onValueChange,
}: {
  kind: GearCatalogKind;
  label: string;
  value: string;
  brand: string;
  onBrandChange(value: string): void;
  onValueChange(value: string): void;
}) {
  const brandChoices = useMemo<Choice[]>(() => [
    { id: OTHER, label: "Other / not listed" },
    ...gearBrands(kind).map((name) => ({ id: name, label: name })),
  ], [kind]);
  const productChoices = useMemo<Choice[]>(() => [
    { id: OTHER, label: "Other / not listed" },
    ...gearProducts(kind, brand).map((product) => productChoice(product)),
  ], [brand, kind]);
  const product = findCatalogProduct(kind, value);

  return (
    <fieldset className="gear-catalog-row">
      <legend>{label}</legend>
      <SearchChoice
        label={`${label} company`}
        placeholder="Search company…"
        choices={brandChoices}
        value={brand}
        onChange={onBrandChange}
      />
      {brand && brand !== OTHER ? (
        <SearchChoice
          label={`${label} model`}
          placeholder={`Search ${brand} ${label.toLowerCase()}s…`}
          choices={productChoices}
          value={product?.label ?? ""}
          onChange={(choice) => {
            if (choice === OTHER) {
              onBrandChange(OTHER);
              onValueChange("");
            } else {
              onValueChange(choice);
            }
          }}
        />
      ) : (
        <label className="trip-field gear-other-field">
          <span>{label} details <em>optional</em></span>
          <input maxLength={kind === "lure" ? 200 : 160} value={value} onChange={(event) => onValueChange(event.target.value)} placeholder={`Enter ${label.toLowerCase()} brand and model…`} />
        </label>
      )}
    </fieldset>
  );
}

function SearchChoice({ label, placeholder, choices, value, onChange }: {
  label: string;
  placeholder: string;
  choices: Choice[];
  value: string;
  onChange(value: string): void;
}) {
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = choices.find((choice) => choice.id === value || choice.label === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const other = choices.find((choice) => choice.id === OTHER);
    const filtered = choices.filter((choice) => choice.id !== OTHER && (!normalized || `${choice.label} ${choice.detail ?? ""}`.toLowerCase().includes(normalized)));
    return [...(other ? [other] : []), ...filtered].slice(0, 18);
  }, [choices, query]);

  const choose = (choice: Choice) => {
    onChange(choice.id);
    setQuery(choice.label);
    setOpen(false);
    setActiveIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter" && open && results[activeIndex]) {
      event.preventDefault();
      choose(results[activeIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="gear-search-choice" ref={rootRef} onBlur={(event) => {
      if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <label htmlFor={inputId}>{label}</label>
      <div className="gear-search-control">
        <input
          id={inputId}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          value={open ? query : selected?.label ?? query}
          placeholder={placeholder}
          onFocus={() => { setOpen(true); setQuery(selected?.label ?? ""); setActiveIndex(0); }}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); }}
          onKeyDown={onKeyDown}
        />
        <span aria-hidden="true">⌄</span>
      </div>
      {open ? (
        <div className="gear-search-results" id={listId} role="listbox">
          {results.length ? results.map((choice, index) => (
            <button
              id={`${listId}-${index}`}
              key={choice.id}
              type="button"
              role="option"
              aria-selected={choice.id === value || choice.label === value}
              className={index === activeIndex ? "active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(choice)}
            >
              <strong>{choice.label}</strong>
              {choice.detail ? <small>{choice.detail}</small> : null}
            </button>
          )) : <p>No matching catalog items. Choose Other / not listed.</p>}
        </div>
      ) : null}
    </div>
  );
}

function productChoice(product: GearCatalogProduct): Choice {
  return { id: product.label, label: product.label, detail: `${product.series} · ${product.model}` };
}
