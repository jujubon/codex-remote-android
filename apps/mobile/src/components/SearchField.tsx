import { CloseIcon, SearchIcon } from './Icons';

export function SearchField({ label, placeholder, value, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return <div className="search-field">
    <SearchIcon aria-hidden="true" />
    <input type="search" aria-label={label} placeholder={placeholder} value={value}
      onChange={event => onChange(event.target.value)} />
    {value && <button className="nav-icon-button" type="button" aria-label="清空搜索" onClick={() => onChange('')}>
      <CloseIcon aria-hidden="true" />
    </button>}
  </div>;
}
