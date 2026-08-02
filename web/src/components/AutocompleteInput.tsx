import { type KeyboardEvent, useState } from "react";

interface AutocompleteInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** 이미 순위가 매겨진 후보(`search.ts::rankByQuery` 결과). 개수 제한은 호출부 책임이다. */
  suggestions: string[];
  onSelect?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}

/**
 * 접근성 있는 자동완성 입력(ARIA combobox-list 패턴).
 *
 * `role="combobox"` + `aria-expanded`/`aria-activedescendant` 로 스크린 리더가 현재 뭐가
 * 펼쳐져 있고 뭐가 강조돼 있는지 알 수 있게 한다. ↑↓ 로 후보를 옮기고 Enter 로 고르며 Esc 로
 * 닫는다. 후보 목록 자체(순위 계산·개수 제한)는 호출부가 `search.ts::rankByQuery` 로 만들어
 * `suggestions` 로 넘긴다 — 이 컴포넌트는 펼치고/옮기고/고르는 상호작용만 맡는다.
 */
export function AutocompleteInput({
  id,
  value,
  onChange,
  suggestions,
  onSelect,
  placeholder,
  required,
  ...rest
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const listboxId = `${id}-listbox`;
  const describedBy = rest["aria-describedby"];

  const visible = open && suggestions.length > 0;

  function select(suggestion: string): void {
    onChange(suggestion);
    onSelect?.(suggestion);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!visible) {
      if (event.key === "ArrowDown" && suggestions.length > 0) {
        event.preventDefault();
        setOpen(true);
        setHighlighted(0);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlighted((prev) => (prev + 1) % suggestions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlighted((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
        break;
      case "Enter":
        if (highlighted >= 0) {
          event.preventDefault();
          select(suggestions[highlighted] as string);
        }
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        setHighlighted(-1);
        break;
      default:
        break;
    }
  }

  const activeId = highlighted >= 0 ? `${id}-option-${highlighted}` : undefined;

  return (
    <div className="autocomplete">
      <input
        id={id}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlighted(-1);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      />
      {visible && (
        <div className="autocomplete-list" role="listbox" id={listboxId}>
          {suggestions.map((suggestion, index) => (
            // 입력이 계속 포커스를 쥐고 aria-activedescendant 로 강조만 옮기는 combobox
            // 패턴이라(위 ARIA 콤보박스 패턴 설명 참고), 후보 자체는 실제로 포커스를
            // 받지 않는다 — tabIndex=-1 로 탭 순서에서는 빼고 스크립트로만 포커스 가능하게
            // 해 접근성 린트의 "포커스 가능해야 한다" 요건만 만족시킨다. 키보드 선택은
            // 입력의 Enter 로 이미 처리되므로 onKeyDown 을 여기 또 달 필요가 없다.
            // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 선택은 입력의 Enter 로 처리한다(activedescendant 패턴)
            <div
              key={suggestion}
              id={`${id}-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === highlighted}
              className={index === highlighted ? "active" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(suggestion)}
            >
              {suggestion}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
