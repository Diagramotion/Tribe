import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

const selectWidths = {
  compact: { trigger: 92, menu: 156 },
  narrow: { trigger: 108, menu: 164 },
  regular: { trigger: 184, menu: 208 },
};

export function SelectControl({ label, value, options, onChange, disabled = false, className = "", size = "regular", id, ...ariaProps }) {
  const generatedId = useId();
  const listboxId = `tribe-select-${generatedId}`;
  const triggerRef = useRef(null);
  const listboxRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
  const selectedOption = options[selectedIndex];
  const fullWidth = size === "full";
  const sizing = selectWidths[size] ?? selectWidths.regular;

  useEffect(() => {
    if (!open) return undefined;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(fullWidth ? rect.width : Math.max(rect.width, sizing.menu), window.innerWidth - 24);
      const maxHeight = Math.min(300, window.innerHeight - 24);
      const expectedHeight = Math.min(maxHeight, options.length * 36 + 10);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const top = below >= expectedHeight || below >= above
        ? rect.bottom + 6
        : Math.max(12, rect.top - expectedHeight - 6);
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      setPosition({ top, left, width, maxHeight });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    function dismissOutside(event) {
      if (!triggerRef.current?.contains(event.target) && !listboxRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, [open, options.length, fullWidth, sizing.menu]);

  useLayoutEffect(() => {
    if (open && position) optionRefs.current[activeIndex]?.focus();
  }, [open, position, activeIndex]);

  function enabledIndex(start, direction) {
    if (!options.length) return 0;
    let index = start;
    for (let attempt = 0; attempt < options.length; attempt += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index].disabled) return index;
    }
    return start;
  }

  function selectOption(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleOptionKeyDown(event, index) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = enabledIndex(index, event.key === "ArrowDown" ? 1 : -1);
      setActiveIndex(next);
      optionRefs.current[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home"
        ? options.findIndex((option) => !option.disabled)
        : options.findLastIndex((option) => !option.disabled);
      if (next >= 0) {
        setActiveIndex(next);
        optionRefs.current[next]?.focus();
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return <div className={`tribe-select tribe-select--${size} ${className}`.trim()}>
    <button {...ariaProps} aria-expanded={open} aria-haspopup="listbox" aria-label={ariaProps["aria-label"] ?? label} aria-controls={listboxId} className="tribe-select-trigger" disabled={disabled} id={id} onClick={() => {
      const nextOpen = !open;
      setActiveIndex(selectedIndex);
      if (nextOpen) setPosition(null);
      setOpen(nextOpen);
    }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(selectedIndex);
        setPosition(null);
        setOpen(true);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }} ref={triggerRef} type="button">
      <span>{selectedOption?.label ?? "Choose"}</span><CaretDown aria-hidden="true" size={13} />
    </button>
    {open && position && <div aria-label={label} className="tribe-select-menu" id={listboxId} ref={listboxRef} role="listbox" style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}>
      {options.map((option, index) => <div aria-disabled={option.disabled || undefined} aria-selected={String(option.value) === String(value)} className={`tribe-select-option${String(option.value) === String(value) ? " tribe-select-option--selected" : ""}`} key={String(option.value)} onClick={() => selectOption(index)} onFocus={() => setActiveIndex(index)} onKeyDown={(event) => handleOptionKeyDown(event, index)} ref={(node) => { optionRefs.current[index] = node; }} role="option" tabIndex={option.disabled ? -1 : 0}>
        <span>{option.label}</span>{String(option.value) === String(value) && <Check aria-hidden="true" size={15} />}
      </div>)}
    </div>}
  </div>;
}
