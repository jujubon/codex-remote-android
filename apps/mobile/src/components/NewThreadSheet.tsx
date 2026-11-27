import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Assistant, ModelOption } from '../types/protocol';
import { isAbsoluteHostPath } from '../lib/hostPath';
import { ChevronDownIcon, CloseIcon } from './Icons';
import { AttachmentDraftPreview } from './AttachmentDraftPreview';

interface NewThreadSheetProps {
  initialDirectory?: string;
  desktopOnly: boolean;
  antigravityAvailable?: boolean;
  antigravityAttachments?: boolean;
  initialAssistant?: Assistant;
  projectMenus: boolean;
  projectStatus: string;
  directories: string[];
  models: ModelOption[];
  defaultModel: string;
  onClose: () => void;
  onStart: (cwd: string, model?: string, modelProvider?: string, prompt?: string, destination?: 'projectless' | 'newProject', projectName?: string, assistant?: Assistant, files?: File[]) => Promise<boolean> | boolean;
}

export function NewThreadSheet({ initialDirectory, desktopOnly, antigravityAvailable, antigravityAttachments, initialAssistant, projectMenus, projectStatus, directories, models, defaultModel, onClose, onStart }: NewThreadSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState('');
  const [assistant, setAssistant] = useState<Assistant>(antigravityAvailable && initialAssistant === 'antigravity' ? 'antigravity' : 'codex');
  const usingAntigravity = assistant === 'antigravity';
  const hasProjectModes = projectMenus || usingAntigravity;
  const [cwd, setCwd] = useState(initialDirectory ?? '');
  const [mode, setMode] = useState<'existing' | 'projectless' | 'newProject'>(hasProjectModes && !initialDirectory ? 'projectless' : 'existing');
  const [projectName, setProjectName] = useState('');
  const sameDirectory = (path: string) => path.toLowerCase().replaceAll('\\', '/') === cwd.toLowerCase().replaceAll('\\', '/');
  const selectedDirectory = directories.find(sameDirectory);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [modelProvider, setModelProvider] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<File>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const useAttachments = usingAntigravity && antigravityAttachments === true;

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current) return;
    if (mode === 'existing' && projectMenus && !selectedDirectory) { setError('请选择电脑上的已有项目'); return; }
    if (mode === 'existing' && !isAbsoluteHostPath(cwd.trim())) {
      setError('请输入电脑上的绝对路径');
      return;
    }
    const attachments = useAttachments ? files : [];
    if ((desktopOnly || usingAntigravity) && !prompt.trim() && !attachments.length) { setError('请输入首条消息或添加附件'); return; }
    if (mode === 'newProject' && !projectName.trim()) { setError('请输入项目名称'); return; }
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      if (await onStart(selectedDirectory ?? cwd, usingAntigravity ? undefined : model || undefined, usingAntigravity ? undefined : modelProvider || undefined,
        prompt.trim(), mode === 'existing' ? undefined : mode, mode === 'newProject' ? projectName.trim() : undefined, assistant, attachments)) dialog.current?.close();
      else setError('未能确认新聊天，消息和附件已保留。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未能创建新聊天。');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return <>
    <dialog className="session-dialog new-thread-dialog" ref={dialog} aria-labelledby="new-thread-title" onClose={onClose}
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="session-sheet">
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <h2 id="new-thread-title">新聊天</h2>
          <button className="icon-button nav-icon-button" type="button" onClick={() => dialog.current?.close()} aria-label="关闭"><CloseIcon /></button>
        </div>
        <form className="new-thread-form" onSubmit={submit}>
          {antigravityAvailable && <label><span>助手</span><select value={assistant} disabled={sending} onChange={event => {
            const next = event.target.value as Assistant;
            setAssistant(next);
            if (next === 'antigravity' && (mode === 'newProject' || !cwd)) setMode('projectless');
            if (next === 'codex' && !projectMenus) setMode('existing');
            setError('');
          }}><option value="codex">Codex</option><option value="antigravity">Antigravity</option></select></label>}
          {(desktopOnly || usingAntigravity) && <label><span>首条消息</span><textarea required={!(useAttachments && files.length)} disabled={sending} placeholder={`给 ${usingAntigravity ? 'Antigravity' : 'Codex'} 发消息…`} rows={3} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>}
          {useAttachments && <div className="new-thread-attachments">
            <label className="secondary-button">添加附件
              <input type="file" multiple aria-label="添加附件" disabled={sending} onChange={event => {
                const selected = [...files, ...Array.from(event.target.files ?? [])];
                event.target.value = '';
                if (selected.length > 10 || selected.reduce((total, file) => total + file.size, 0) > 12 * 1024 * 1024) {
                  setError('最多可附带 10 个文件，合计不超过 12 MB。');
                  return;
                }
                setFiles(selected);
                setError('');
              }} />
            </label>
            {files.length > 0 && <div className="attachment-chips">
              {files.map((file, index) => <div className="attachment-chip" key={index}>
                <button className="attachment-chip-body" type="button" onClick={() => setPreview(file)} aria-label={`预览 ${file.name}`}><span>{file.name}</span></button>
                <button className="attachment-chip-remove" type="button" disabled={sending} onClick={() => setFiles(current => current.filter((_, i) => i !== index))} aria-label={`移除 ${file.name}`}><CloseIcon /></button>
              </div>)}
            </div>}
          </div>}
          {hasProjectModes && <label><span>项目（可选）</span><select value={mode} onChange={event => {
            setMode(event.target.value as typeof mode); setError('');
          }}>
            <option value="projectless">直接新聊天（无项目）</option>
            <option value="existing">在已有项目中聊天</option>
            {projectMenus && !usingAntigravity && <option value="newProject">新建项目并聊天</option>}
          </select></label>}
          {desktopOnly && !hasProjectModes && <small>更新 Windows 配套程序后，即可直接聊天或新建项目。</small>}
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
          {!desktopOnly && !usingAntigravity && <button className="advanced-toggle" type="button" aria-expanded={showAdvanced} aria-controls="new-thread-model-settings"
            onClick={() => setShowAdvanced((value) => !value)}>
            <span>模型高级设置</span><ChevronDownIcon />
          </button>}
          {!desktopOnly && !usingAntigravity && (
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
            <button className="primary-button" type="submit" disabled={sending}>{sending ? '正在创建…' : '开始聊天'}</button>
          </div>
        </form>
      </div>
    </dialog>
    {preview && <AttachmentDraftPreview draft={{ name: preview.name, size: preview.size, file: preview }} onClose={() => setPreview(undefined)} />}
  </>;
}
