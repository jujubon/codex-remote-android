import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModelOption } from '../types/protocol';
import { isAbsoluteHostPath } from '../lib/hostPath';
import { ChevronDownIcon, CloseIcon } from './Icons';

interface NewThreadSheetProps {
  initialDirectory?: string;
  desktopOnly: boolean;
  projectMenus: boolean;
  projectStatus: string;
  directories: string[];
  models: ModelOption[];
  defaultModel: string;
  onClose: () => void;
  onStart: (cwd: string, model?: string, modelProvider?: string, prompt?: string, destination?: 'projectless' | 'newProject', projectName?: string) => boolean;
}

export function NewThreadSheet({ initialDirectory, desktopOnly, projectMenus, projectStatus, directories, models, defaultModel, onClose, onStart }: NewThreadSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(initialDirectory ?? '');
  const [mode, setMode] = useState<'existing' | 'projectless' | 'newProject'>(projectMenus && !initialDirectory ? 'projectless' : 'existing');
  const [projectName, setProjectName] = useState('');
  const sameDirectory = (path: string) => path.toLowerCase().replaceAll('\\', '/') === cwd.toLowerCase().replaceAll('\\', '/');
  const selectedDirectory = directories.find(sameDirectory);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [modelProvider, setModelProvider] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'existing' && projectMenus && !selectedDirectory) { setError('请选择电脑上的已有项目'); return; }
    if (mode === 'existing' && !isAbsoluteHostPath(cwd.trim())) {
      setError('请输入电脑上的绝对路径');
      return;
    }
    if (desktopOnly && !prompt.trim()) { setError('请输入首条任务'); return; }
    if (mode === 'newProject' && !projectName.trim()) { setError('请输入项目名称'); return; }
    if (onStart(selectedDirectory ?? cwd, model || undefined, modelProvider || undefined, prompt.trim(), mode === 'existing' ? undefined : mode, mode === 'newProject' ? projectName.trim() : undefined)) dialog.current?.close();
    else setError('任务创建请求未发送，请确认连接状态');
  }

  return (
    <dialog className="session-dialog new-thread-dialog" ref={dialog} aria-labelledby="new-thread-title" onClose={onClose}
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="session-sheet">
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <h2 id="new-thread-title">新聊天</h2>
          <button className="icon-button nav-icon-button" type="button" onClick={() => dialog.current?.close()} aria-label="关闭"><CloseIcon /></button>
        </div>
        <form className="new-thread-form" onSubmit={submit}>
          {desktopOnly && <label><span>首条消息</span><textarea required placeholder="给 Codex 发消息…" rows={3} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>}
          {projectMenus && <label><span>项目（可选）</span><select value={mode} onChange={event => {
            setMode(event.target.value as typeof mode); setError('');
          }}>
            <option value="projectless">直接新聊天（无项目）</option>
            <option value="existing">在已有项目中聊天</option>
            <option value="newProject">新建项目并聊天</option>
          </select></label>}
          {desktopOnly && !projectMenus && <small>更新 Windows 配套程序后，即可直接聊天或新建项目。</small>}
          {mode === 'existing' && <label>
            <span>电脑工作目录</span>
            {(directories.length > 0 || projectMenus) && <select aria-label="选择已有项目" value={selectedDirectory ?? ''} onChange={(event) => setCwd(event.target.value)}>
              <option value="">{projectMenus ? '选择电脑上的项目' : '选择已有项目或输入路径'}</option>
              {directories.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>}
            {!projectMenus && <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="D:\Code\project" autoCapitalize="none" autoCorrect="off" />}
            {projectMenus && projectStatus && <small role="status">{projectStatus}</small>}
          </label>}
          {mode === 'newProject' && <label><span>新项目名称</span>
            <input value={projectName} onChange={event => setProjectName(event.target.value)} maxLength={100} required />
            <small>保存到电脑个人文件夹的 CodexProjects 目录下。</small>
          </label>}
          {!desktopOnly && <button className="advanced-toggle" type="button" aria-expanded={showAdvanced} aria-controls="new-thread-model-settings"
            onClick={() => setShowAdvanced((value) => !value)}>
            <span>模型高级设置</span><ChevronDownIcon />
          </button>}
          {!desktopOnly && (
            <div className="advanced-fields computer-reveal" id="new-thread-model-settings" hidden={!showAdvanced}>
              <label>
                <span>模型（可选）</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">使用主机默认值</option>
                  {models.filter((option) => !option.hidden).map((option) => <option key={option.id} value={option.model}>{option.displayName || option.model}</option>)}
                </select>
              </label>
              <label><span>模型提供方（自定义端点时可选）</span><input value={modelProvider} onChange={(event) => setModelProvider(event.target.value)} placeholder="使用主机默认值" autoCapitalize="none" /></label>
            </div>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="sheet-actions">
            <button className="secondary-button" type="button" onClick={() => dialog.current?.close()}>取消</button>
            <button className="primary-button" type="submit">开始聊天</button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
