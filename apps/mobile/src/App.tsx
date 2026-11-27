import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveDialog, type ArchiveTarget } from './components/ArchiveDialog';
import { AntigravityDeleteDialog, type AntigravityDeleteTarget } from './components/AntigravityDeleteDialog';
import { ConversationScreen } from './components/ConversationScreen';
import { ComputerScreen } from './components/ComputerScreen';
import { stopCrossNetworkReader } from './components/CrossNetworkReader';
import { DevicePowerDialog } from './components/DeviceTools';
import { HomeNav, type HomePage } from './components/HomeNav';
import { CloseIcon } from './components/Icons';
import { NewThreadSheet } from './components/NewThreadSheet';
import { RenameThreadDialog, type RenameThreadTarget } from './components/RenameThreadDialog';
import { SetupScreen } from './components/SetupScreen';
import { ThreadList, type ThreadListPosition } from './components/ThreadList';
import { AccountUsagePanel } from './components/AccountUsagePanel';
import { useHiddenProjects, useHiddenThreads, useRemovedProjects } from './lib/hiddenProjects';
import { composerDraftKey, forgetComposerDrafts, saveComposerDraft } from './lib/composerDraft';
import { emptyAttachmentDraft, forgetAttachmentDrafts, saveAttachmentDraft } from './lib/attachmentDrafts';
import { loadAttachmentCleanupPreference, saveAttachmentCleanupPreference } from './lib/attachmentPreferences';
import { cacheScope } from './lib/remoteCache';
import { useRemote } from './hooks/useRemote';
import { clearRemoteConfig, loadRemoteConfig, type RemoteConfig } from './lib/configStore';
import { initializeNotifications } from './lib/notifications';
import { loadInboxImage, type InboxFile } from './lib/deviceTools';
import { AssistantDesktopAction } from './components/AssistantDesktopAction';
import { StartupUpdateDialog } from './components/StartupUpdateDialog';
import { useAntigravityUsage } from './hooks/useAntigravityUsage';
import { useAntigravityModels } from './hooks/useAntigravityModels';
import { useStartupUpdate } from './hooks/useStartupUpdate';
import { parseAttentionAction, type AttentionTarget } from './lib/attention';
import { CodexBackground, resumeBackgroundRuntime, startBackgroundRuntime, updateBackgroundThread } from './lib/background';
import type { Assistant } from './types/protocol';
import { compareReleaseVersions, type StartupUpdate } from './lib/updates';

const assistantPageKey = 'codex-mobile.assistant-page.v1';
function savedAssistantPage(): Assistant {
  try { return localStorage.getItem(assistantPageKey) === 'antigravity' ? 'antigravity' : 'codex'; }
  catch { return 'codex'; }
}

function emptyListPosition(): ThreadListPosition {
  return { query: '', filter: '全部项目', scrollTop: 0 };
}

export function popThreadBackStack(stack: string[]): { previousThreadId: string | null; remaining: string[] } {
  if (stack.length === 0) return { previousThreadId: null, remaining: [] };
  return { previousThreadId: stack.at(-1) ?? null, remaining: stack.slice(0, -1) };
}

export function App() {
  const [config, setConfig] = useState<RemoteConfig | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [deleteAttachmentsAfterTurn, setDeleteAttachmentsAfterTurn] = useState<boolean>();
  const [homePage, setHomePage] = useState<HomePage>(savedAssistantPage);
  const [startupUpdateHandled, setStartupUpdateHandled] = useState(false);
  const [requestedUpdate, setRequestedUpdate] = useState<StartupUpdate>();
  const lastAssistantPage = useRef<Assistant>(homePage === 'antigravity' ? 'antigravity' : 'codex');
  const [taskPowerThreadId, setTaskPowerThreadId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameThreadTarget>();
  const [deleteAntigravityTarget, setDeleteAntigravityTarget] = useState<AntigravityDeleteTarget>();
  const [showNewThread, setShowNewThread] = useState(false);
  const [newDirectory, setNewDirectory] = useState<string>();
  const [newAssistant, setNewAssistant] = useState<Assistant>('codex');
  const [backgroundError, setBackgroundError] = useState('');
  const [inboxSelection, setInboxSelection] = useState<{ file: InboxFile; threadId?: string }>();
  const [attention, setAttention] = useState<{ threadId: string; target: AttentionTarget }>();
  const [selectedAgentByThread, setSelectedAgentByThread] = useState<Record<string, string | null>>({});
  const threadBackStackRef = useRef<string[]>([]);
  const codexPosition = useRef<ThreadListPosition>(emptyListPosition());
  const antigravityPosition = useRef<ThreadListPosition>(emptyListPosition());
  const remote = useRemote(config ?? null, deleteAttachmentsAfterTurn === true);
  const startupUpdate = useStartupUpdate(Boolean(config), remote.hostVersion);
  const antigravityUsage = useAntigravityUsage(config, remote.connectionUrl, remote.phase === 'connected');
  const antigravityModels = useAntigravityModels(config, remote.connectionUrl, remote.phase === 'connected');
  const needsAntigravityModels = remote.selectedThread?.assistant === 'antigravity' || (showNewThread && newAssistant === 'antigravity');
  useEffect(() => {
    if (needsAntigravityModels) void antigravityModels.refresh();
  }, [needsAntigravityModels, antigravityModels.refresh]);
  const pageThreads = useMemo(() => remote.threads.filter(thread => (thread.assistant ?? 'codex') === homePage), [remote.threads, homePage]);
  useEffect(() => {
    if (remote.phase !== 'connected' || homePage === 'computer') return;
    const usage = homePage === 'codex' ? remote.usage : antigravityUsage.usage;
    if (usage && Date.now() - usage.checkedAt < 60_000) return;
    if (homePage === 'codex') remote.refreshUsage();
    else void antigravityUsage.refresh();
  }, [config, homePage, remote.phase]);
  const listHost = remote.serverId ?? config?.serverUrl ?? '';
  const activeAssistant = homePage === 'computer' ? lastAssistantPage.current : homePage;
  const projectHost = activeAssistant === 'antigravity' ? `antigravity:${listHost}` : listHost;
  const hidden = useHiddenProjects(projectHost);
  const hiddenThreads = useHiddenThreads(listHost);
  const removed = useRemovedProjects(projectHost);
  const showDirectory = (path: string) => Boolean(path) && !hidden.isHidden(path) && !removed.isHidden(path);

  const goToPage = useCallback((page: HomePage) => {
    setHomePage(page);
    if (page !== 'computer') {
      lastAssistantPage.current = page;
      try { localStorage.setItem(assistantPageKey, page); } catch { /* Keep the preference in memory. */ }
    }
  }, []);

  const openRootThread = useCallback((threadId: string, target?: AttentionTarget) => {
    threadBackStackRef.current = [];
    goToPage(threadId.startsWith('antigravity:') ? 'antigravity' : 'codex');
    setTaskPowerThreadId(null);
    setAttention(target ? { threadId, target } : undefined);
    setSelectedAgentByThread((current) => ({ ...current, [threadId]: null }));
    remote.selectThread(threadId);
  }, [goToPage, remote.selectThread]);

  useEffect(() => {
    const threadId = remote.selectedThread?.id;
    if (threadId && (remote.selectedThread?.assistant !== 'antigravity' || remote.antigravityAttachments))
      setInboxSelection(current => current && !current.threadId ? { ...current, threadId } : current);
  }, [remote.selectedThread?.id, remote.selectedThread?.assistant, remote.antigravityAttachments]);

  const openNestedThread = useCallback((threadId: string) => {
    const currentThreadId = remote.selectedThreadId;
    if (currentThreadId && currentThreadId !== threadId) threadBackStackRef.current.push(currentThreadId);
    setSelectedAgentByThread((current) => ({ ...current, [threadId]: null }));
    remote.selectThread(threadId);
  }, [remote.selectThread, remote.selectedThreadId]);

  const navigateBack = useCallback(() => {
    const currentThreadId = remote.selectedThreadId;
    if (currentThreadId && selectedAgentByThread[currentThreadId]) {
      setSelectedAgentByThread((current) => ({ ...current, [currentThreadId]: null }));
      return;
    }
    const { previousThreadId, remaining } = popThreadBackStack(threadBackStackRef.current);
    threadBackStackRef.current = remaining;
    if (previousThreadId) {
      remote.selectThread(previousThreadId);
      return;
    }
    remote.selectThread(null);
  }, [remote.selectThread, remote.selectedThreadId, selectedAgentByThread]);

  useEffect(() => {
    void loadRemoteConfig().then(setConfig).catch(() => setConfig(null));
    void loadAttachmentCleanupPreference().then(setDeleteAttachmentsAfterTurn).catch(() => setDeleteAttachmentsAfterTurn(false));
    void initializeNotifications();
    if (Capacitor.isNativePlatform()) {
      void SystemBars.setStyle({ style: SystemBarsStyle.Light });
    }
  }, []);

  useEffect(() => {
    if (config === undefined || !Capacitor.isNativePlatform()) return;
    if (config === null) {
      void CodexBackground.stop();
      return;
    }
    void startBackgroundRuntime(config, remote.selectedThreadId ?? undefined).then((running) => {
      setBackgroundError(running ? '' : 'Android 后台通知服务未启动；请检查通知权限后重新回到 App。');
    });
  }, [config]);

  useEffect(() => {
    if (!config || !Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      void resumeBackgroundRuntime(config, remote.selectedThreadId ?? undefined).then((running) => {
        setBackgroundError(running ? '' : 'Android 后台通知服务仍未启动；请确认通知权限和系统后台运行限制。');
      });
    }).then((handle) => { listener = handle; });
    return () => void listener?.remove();
  }, [config, remote.selectedThreadId]);

  useEffect(() => {
    if (!config || !Capacitor.isNativePlatform()) return;
    void updateBackgroundThread(remote.selectedThreadId ?? undefined, remote.selectedThread?.title);
  }, [config, remote.selectedThread?.title, remote.selectedThreadId]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    const consumedNonces = new Set<string>();
    const openAction = (action: { threadId?: string; nonce?: string; action?: string }) => {
      if (action.nonce && consumedNonces.has(action.nonce)) return;
      if (action.nonce) consumedNonces.add(action.nonce);
      if (action.threadId && action.threadId !== 'global') openRootThread(action.threadId, parseAttentionAction(action.action));
    };
    void CodexBackground.addListener('notificationAction', openAction).then((handle) => { listener = handle; });
    void CodexBackground.consumePendingAction().then(({ action }) => { if (action) openAction(action); }).catch(() => undefined);
    return () => void listener?.remove();
  }, [openRootThread]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    let disposed = false;
    void CapacitorApp.addListener('backButton', () => {
      const dialog = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
      if (dialog) { if (!dialog.hasAttribute('data-confirming')) dialog.close(); }
      else if (showNewThread) setShowNewThread(false);
      else if (showSettings) setShowSettings(false);
      else if (remote.selectedThreadId) navigateBack();
      else if (homePage === 'computer') goToPage(lastAssistantPage.current);
      else void CapacitorApp.exitApp();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else listener = handle;
    });
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [goToPage, homePage, navigateBack, remote.selectedThreadId, showNewThread, showSettings]);


  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    void LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
      const extra = notification.extra as { threadId?: unknown; action?: unknown } | undefined;
      if (typeof extra?.threadId === 'string') openRootThread(extra.threadId, parseAttentionAction(extra.action));
    }).then((handle) => {
      listener = handle;
    });
    return () => void listener?.remove();
  }, [openRootThread]);

  async function forgetConnection() {
    await stopCrossNetworkReader();
    if (Capacitor.isNativePlatform()) await CodexBackground.stop().catch(() => undefined);
    await clearRemoteConfig();
    await saveAttachmentCleanupPreference(false);
    setDeleteAttachmentsAfterTurn(false);
    if (config) {
      const scope = cacheScope(config.serverUrl, config.pairingToken);
      forgetComposerDrafts(scope);
      await forgetAttachmentDrafts(composerDraftKey(scope, '')).catch(() => undefined);
    }
    codexPosition.current = emptyListPosition();
    antigravityPosition.current = emptyListPosition();
    setShowSettings(false);
    setConfig(null);
    setInboxSelection(undefined);
    setAttention(undefined);
    goToPage('codex');
  }

  if (config === undefined) {
    return (
      <main className="loading-screen">
        <div className="brand-mark"><span /></div>
        <p>正在读取安全配置…</p>
      </main>
    );
  }

  const activeUsage = activeAssistant === 'antigravity'
    ? { ...antigravityUsage, assistantName: 'Antigravity' }
    : { usage: remote.usage, status: remote.usageStatus, refresh: () => remote.refreshUsage(),
      resetConfig: config ? { ...config, serverUrl: remote.connectionUrl || config.serverUrl } : undefined,
      onReset: () => remote.refreshUsage(true) };
  const accountPanel = <AccountUsagePanel {...activeUsage} />;
  const quotaWindows = activeUsage.usage?.windows.filter(window => Number.isFinite(window.remainingPercent));
  const quotaPercent = quotaWindows?.length
    ? Math.round(Math.min(100, Math.max(0, Math.min(...quotaWindows.map(window => window.remainingPercent)))))
    : undefined;

  if (!config || showSettings) {
    return (
      <SetupScreen
        initialConfig={config}
        onSaved={(saved) => {
          if (config?.serverUrl !== saved.serverUrl || config?.pairingToken !== saved.pairingToken) {
            void stopCrossNetworkReader();
            setInboxSelection(undefined);
            setAttention(undefined);
          }
          setConfig(saved);
          setShowSettings(false);
        }}
        onCancel={config ? () => setShowSettings(false) : undefined}
        onFullRefresh={config ? async () => {
          await remote.fullRefresh();
          setShowSettings(false);
        } : undefined}
        onForget={config ? () => void forgetConnection() : undefined}
      />
    );
  }

  const notice = <>
      {!remote.selectedThread && inboxSelection && (
        <div className="error-toast" role="status">
          <span>已选 {inboxSelection.file.fileName} · {inboxSelection.threadId ? '已添加到所选对话的输入框' : '打开对话后发送'}</span>
          <button className="nav-icon-button" aria-label="取消附件选择" type="button" onClick={() => setInboxSelection(undefined)}><CloseIcon /></button>
        </div>
      )}
      {!remote.lastError && !backgroundError && remote.queueReceipt && (
        <div className="error-toast receipt-toast" role="status"><span>{remote.queueReceipt}</span><button type="button" aria-label="关闭回执" className="nav-icon-button" onClick={remote.dismissReceipt}><CloseIcon /></button></div>
      )}
      {(remote.lastError || backgroundError) && (
        <div className="error-toast" role="alert">
          <span>{remote.lastError || backgroundError}</span>
          <button type="button" onClick={() => { remote.dismissError(); setBackgroundError(''); }} className="nav-icon-button" aria-label="关闭错误提示"><CloseIcon /></button>
        </div>
      )}
  </>;

  const phaseDetail = remote.phaseDetail || (homePage === 'codex' && remote.phase === 'connected' && !remote.codexReady ? '已连接电脑，Codex 服务正在等待就绪' : '');
  const homeNav = <HomeNav page={homePage} onNavigate={goToPage} />;
  const draftKey = composerDraftKey(cacheScope(config.serverUrl, config.pairingToken), remote.selectedThread?.id ?? '');

  return (
    <>
      {remote.selectedThread ? (
        <ConversationScreen
          key={draftKey}
          draftKey={draftKey}
          inboxFile={inboxSelection?.threadId === remote.selectedThread.id ? inboxSelection.file : undefined}
          loadInboxPreview={(id, signal) => loadInboxImage(config, id, false, signal)}
          onClearInboxFile={id => setInboxSelection(current => current?.file.id === id ? undefined : current)}
          attention={attention?.threadId === remote.selectedThread.id ? attention.target : undefined}
          attentionStatus={remote.threadAttention[remote.selectedThread.id]}
          onTaskPower={() => setTaskPowerThreadId(remote.selectedThreadId)}
          onArchive={remote.archiveSupported && remote.selectedThread.assistant !== 'antigravity' ? () => setArchiveTarget({ id: remote.selectedThread!.id, title: remote.selectedThread!.title }) : undefined}
          accountPanel={accountPanel}
          onRefreshUsage={activeUsage.refresh}
          notice={notice}
          thread={remote.selectedThread}
          messages={remote.selectedMessages}
          subagents={remote.selectedSubagents}
          approvals={remote.selectedApprovals}
          compaction={remote.selectedCompaction}
          promptQueue={remote.selectedPromptQueue}
          gitDiff={remote.selectedGitDiff}
          models={remote.models}
          skills={remote.skills}
          selectedModel={remote.selectedThread.assistant === 'antigravity' ? remote.selectedThread.model ?? '' : remote.selectedModel}
          modelPending={remote.modelPending}
          selectedEffort={remote.selectedEffort}
          selectedPermissionMode={remote.selectedPermissionMode}
          permissionModeStatus={remote.permissionModeStatus}
          phase={remote.phase}
          phaseDetail={remote.phaseDetail}
          running={remote.running}
          canInterrupt={remote.canInterrupt}
          canSteer={remote.canSteer}
          antigravityAttachments={remote.antigravityAttachments}
          antigravityModels={antigravityModels}
          currentTurnId={remote.selectedTurnId}
          historyHasMore={Boolean(remote.selectedHistory?.hasMore)}
          historyLoading={remote.historyLoading}
          selectedAgentId={selectedAgentByThread[remote.selectedThread.id] ?? null}
          onSelectAgent={(agentId) => setSelectedAgentByThread((current) => ({ ...current, [remote.selectedThread!.id]: agentId }))}
          onLoadOlderHistory={remote.loadOlderHistory}
          onBack={navigateBack}
          onReconnect={remote.reconnect}
          onSend={remote.sendMessage}
          onCancelQueuedPrompt={remote.cancelQueuedPrompt}
          onPromoteQueuedPrompt={remote.promoteQueuedPrompt}
          onResumePromptQueue={remote.resumePromptQueue}
          onRefreshGitDiff={remote.refreshGitDiff}
          onInterrupt={remote.interrupt}
          onSelectModel={remote.selectModel}
          onSelectEffort={remote.selectEffort}
          onSelectPermissionMode={remote.selectPermissionMode}
          onResolveApproval={remote.resolveApproval}
          onDismissCompaction={() => remote.dismissCompaction(remote.selectedThread!.id)}
          onOpenThread={openNestedThread}
          onLoadAttachment={remote.loadHostAttachment}
          onDownloadAttachment={remote.downloadHostAttachment}
          onDiscardLocalMessage={remote.discardLocalMessage}
        />
      ) : homePage === 'computer' ? (
        <ComputerScreen config={config}
          hostVersion={remote.hostVersion}
          requestedUpdate={requestedUpdate}
          onUpdateStarted={() => setRequestedUpdate(undefined)}
          deleteAttachmentsAfterTurn={deleteAttachmentsAfterTurn}
          onChangeAttachmentCleanup={async (enabled) => {
            await saveAttachmentCleanupPreference(enabled);
            setDeleteAttachmentsAfterTurn(enabled);
          }}
          checkSync={remote.checkConversationSync}
          onUseInbox={file => {
            setInboxSelection({ file });
            goToPage(lastAssistantPage.current);
          }}
          connectionUrl={remote.connectionUrl}
          phase={remote.phase}
          detail={phaseDetail}
          onReconnect={remote.reconnect}
          onSettings={() => setShowSettings(true)}
          footer={homeNav}
          notice={notice} />
      ) : (
        <ThreadList key={homePage}
          assistant={homePage}
          canCreate={remote.phase === 'connected' && (homePage === 'codex' || remote.antigravityAvailable)}
          desktopAction={config && <AssistantDesktopAction assistant={homePage} config={config}
            connectionUrl={remote.connectionUrl} connected={remote.phase === 'connected'} />}
          attention={remote.threadAttention}
          position={homePage === 'codex' ? codexPosition : antigravityPosition}
          onArchives={homePage === 'codex' && remote.archiveSupported ? () => setArchiveTarget('list') : undefined}
          quota={<AccountUsagePanel {...activeUsage} expanded />}
          quotaPercent={quotaPercent}
          onOpenQuota={activeUsage.refresh}
          onArchive={homePage === 'codex' && remote.archiveSupported ? thread => setArchiveTarget({ id: thread.id, title: thread.title }) : undefined}
          onRename={(compareReleaseVersions(remote.hostVersion, '1.0.8') ?? -1) >= 0 ? setRenameTarget : undefined}
          onDelete={homePage === 'antigravity' ? thread => setDeleteAntigravityTarget({ id: thread.id, title: thread.title }) : undefined}
          hidden={hidden}
          hiddenThreads={hiddenThreads}
          removed={removed}
          threads={pageThreads}
          phase={remote.phase}
          phaseDetail={phaseDetail}
          onSelect={openRootThread}
          onCreate={cwd => { setNewDirectory(cwd); setNewAssistant(homePage); setShowNewThread(true); if (remote.desktopProjectMenus) remote.refreshProjects(); }}
          footer={homeNav}
          notice={notice}
          onSettings={() => setShowSettings(true)}
          onReconnect={remote.reconnect}
        />
      )}

      {startupUpdate && !startupUpdateHandled && !remote.selectedThreadId && !showNewThread && !archiveTarget && !renameTarget && !deleteAntigravityTarget &&
        <StartupUpdateDialog update={startupUpdate} onLater={() => setStartupUpdateHandled(true)} onUpdate={update => {
          setStartupUpdateHandled(true);
          setRequestedUpdate(update);
          goToPage('computer');
        }} />}
      {taskPowerThreadId && taskPowerThreadId === remote.selectedThreadId &&
        <DevicePowerDialog config={config} phase={remote.phase} threadId={taskPowerThreadId} onClose={() => setTaskPowerThreadId(null)} />}
      {archiveTarget && <ArchiveDialog target={archiveTarget} connected={remote.phase === 'connected'} request={remote.archiveRequest} onClose={() => setArchiveTarget(null)} />}
      {renameTarget && <RenameThreadDialog target={renameTarget} connected={remote.phase === 'connected'}
        onRename={remote.renameThread} onClose={() => setRenameTarget(undefined)} />}
      {deleteAntigravityTarget && <AntigravityDeleteDialog target={deleteAntigravityTarget}
        disabled={remote.phase !== 'connected' || remote.threads.some(thread => thread.id === deleteAntigravityTarget.id &&
          ['running', 'waiting_approval', 'waiting_input'].includes(thread.state))}
        onDelete={async id => {
          await remote.deleteAntigravityThread(id);
          const key = composerDraftKey(cacheScope(config.serverUrl, config.pairingToken), id);
          saveComposerDraft(key, '');
          void saveAttachmentDraft(key, emptyAttachmentDraft).catch(() => undefined);
        }}
        onClose={() => setDeleteAntigravityTarget(undefined)} />}
      {showNewThread && (
        <NewThreadSheet initialDirectory={newDirectory} desktopOnly={remote.desktopOnly}
          assistant={newAssistant}
          antigravityAttachments={remote.antigravityAttachments}
          antigravityModels={antigravityModels}
          projectMenus={newAssistant === 'codex' && remote.desktopProjectMenus} projectStatus={remote.projectStatus}
          directories={[...new Set([
            ...remote.desktopProjects.map(project => project.path),
            ...(newAssistant === 'antigravity' || !remote.desktopProjectMenus
              ? remote.threads.filter(thread => !thread.projectless).map(thread => thread.cwd) : []),
          ].filter(showDirectory))]}
          models={remote.models} defaultModel={remote.selectedModel} onClose={() => setShowNewThread(false)} onStart={remote.startThread} />
      )}

    </>
  );
}
