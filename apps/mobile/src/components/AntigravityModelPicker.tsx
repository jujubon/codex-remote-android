import type { AntigravityModelCatalog } from '../hooks/useAntigravityModels';
import { ChevronDownIcon, UpdateIcon } from './Icons';

export function AntigravityModelPicker({ catalog, value, onChange, disabled, newThread, pending, running }: {
  catalog: AntigravityModelCatalog;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  newThread?: boolean;
  pending?: boolean;
  running?: boolean;
}) {
  return <div className="agy-model-picker">
    <div className="agy-model-controls">
      <label className="agy-model-field">
        <span>Antigravity 模型</span>
        <span className="agy-model-select">
          <select value={value} onChange={event => onChange(event.target.value)}
            disabled={disabled || pending || running || !catalog.options.length}>
            <option value="">{newThread ? 'CLI 默认模型' : '跟随 CLI 会话'}</option>
            {value && !catalog.options.some(model => model.model === value) && <option value={value} disabled>{value}</option>}
            {catalog.options.map(model => <option key={model.id} value={model.model}>{model.displayName}</option>)}
          </select>
          <ChevronDownIcon aria-hidden="true" />
        </span>
      </label>
      <button className="nav-icon-button agy-model-refresh" type="button" aria-label="刷新 Antigravity 模型"
        disabled={disabled || catalog.loading || pending} onClick={() => void catalog.refresh(true)}>
        <UpdateIcon aria-hidden="true" />
      </button>
    </div>
    {(catalog.loading || catalog.error || !newThread) && <small className="agy-model-note" role="status">
      {catalog.loading ? '正在读取 CLI 可用模型…' : catalog.error || (pending ? '正在保存模型…' : running ? '本轮结束后可更换模型' : '所选模型在下一轮生效')}
    </small>}
  </div>;
}
