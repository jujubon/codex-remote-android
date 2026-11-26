import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveDialog, type ArchiveTarget } from './components/ArchiveDialog';
import { ConversationScreen } from './components/ConversationScreen';
import { ComputerScreen } from './components/ComputerScreen';
import { stopCrossNetworkReader } from './components/CrossNetworkReader';
import { DevicePowerDialog } from './components/DeviceTools';
import { HomeNav, type HomePage } from './components/HomeNav';
import { CloseIcon } from './components/Icons';
import { NewThreadSheet } from './components/NewThreadSheet';
import { SetupScreen } from './components/SetupScreen';
import { ThreadList, type ThreadListPosition } from './components/ThreadList';
import { AccountUsagePanel } from './components/AccountUsagePanel';
import { useHiddenProjects, useHiddenThreads, useRemovedProjects } from './lib/hiddenProjects';
import { composerDraftKey, forgetComposerDrafts } from './lib/composerDraft';
import { forgetAttachmentDrafts } from './lib/attachmentDrafts';
import { cacheScope } from './lib/remoteCache';
import { useRemote } from './hooks/useRemote';
import { clearRemoteConfig, loadRemoteConfig, type RemoteConfig } from './lib/configStore';
import { initializeNotifications } from './lib/notifications';
import { loadInboxImage, type InboxFile } from './lib/deviceTools';
import { parseAttentionAction, type AttentionTarget } from './lib/attention';
import { CodexBackground, resumeBackgroundRuntime, startBackgroundRuntime, updateBackgroundThread } from './lib/background';

export function popThreadBackStack(stack: string[]): { previousThreadId: string | null; remaining: string[] } {
  if (stack.length === 0) return { previousThreadId: null, remaining: [] };
  return { previousThreadId: stack.at(-1) ?? null, remaining: stack.slice(0, -1) };
}

export function App() {
  const [config, setConfig] = useState<RemoteConfig | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [homePage, setHomePage] = useState<HomePage>('projects');
  const [taskPowerThreadId, setTaskPowerThreadId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [showNewThread, setShowNewThread] = useState(false);
  const [newDirectory, setNewDirectory] = useState<string>();
  const [backgroundError, setBackgroundError] = useState('');
  const [inboxSelection, setInboxSelection] = useState<{ file: InboxFile; threadId?: string }>();
  const [attention, setAttention] = useState<{ threadId: string; target: AttentionTarget }>();
  const [selectedAgentByThread, setSelectedAgentByThread] = useState<Record<string, string | null>>({});
  const threadBackStackRef = useRef<string[]>([]);
  const threadListPosition = useRef<ThreadListPosition>({ query: '', filter: '全部项目', scrollTop: 0 });
  const remote = useRemote(config ?? null);
  const listHost = remote.serverId ?? config?.serverUrl ?? '';
  const hidden = useHiddenProjects(listHost);
  const hiddenThreads = useHiddenThreads(listHost);
  const removed = useRemovedProjects(listHost);
  const showDirectory = (path: string) => Boolean(path) && !hidden.isHidden(path) && !removed.isHidden(path);

  const openRootThread = useCallback((threadId: string, target?: AttentionTarget) => {
    threadBackStackRef.current = [];
    setHomePage('projects');
    setTaskPowerThreadId(null);
    setAttention(target ? { threadId, target } : undefined);
    setSelectedAgentByThread((current) => ({ ...current, [threadId]: null }));
    remote.selectThread(threadId);
  }, [remote.selectThread]);

  useEffect(() => {
    const threadId = remote.selectedThread?.id;
    if (threadId) setInboxSelection(current => current && !current.threadId ? { ...current, threadId } : current);
  }, [remote.selectedThread?.id]);

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
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
      if (dialog) dialog.close();
      else if (showNewThread) setShowNewThread(false);
      else if (showSettings) setShowSettings(false);
      else if (remote.selectedThreadId) navigateBack();
      else if (homePage === 'computer') setHomePage('projects');
      else void CapacitorApp.exitApp();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else listener = handle;
    });
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [homePage, navigateBack, remote.selectedThreadId, showNewThread, showSettings]);


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
    if (config) {
      const scope = cacheScope(config.serverUrl, config.pairingToken);
      forgetComposerDrafts(scope);
      await forgetAttachmentDrafts(composerDraftKey(scope, '')).catch(() => undefined);
    }
    threadListPosition.current = { query: '', filter: '全部项目', scrollTop: 0 };
    setShowSettings(false);
    setConfig(null);
    setInboxSelection(undefined);
    setAttention(undefined);
    setHomePage('projects');
  }

  if (config === undefined) {
    return (
      <main className="loading-screen">
        <div className="brand-mark"><span /></div>
        <p>正在读取安全配置…</p>
      </main>
    );
  }

  const accountPanel = <AccountUsagePanel usage={remote.usage} status={remote.usageStatus} refresh={remote.refreshUsage} />;

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

  const phaseDetail = remote.phaseDetail || (remote.phase === 'connected' && !remote.codexReady ? '已连接电脑，Codex 服务正在等待就绪' : '');
  const homeNav = <HomeNav page={homePage} onNavigate={setHomePage} />;
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
          onArchive={remote.archiveSupported ? () => setArchiveTarget({ id: remote.selectedThread!.id, title: remote.selectedThread!.title }) : undefined}
          accountPanel={accountPanel}
          onRefreshUsage={remote.refreshUsage}
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
          selectedModel={remote.selectedModel}
          modelPending={remote.modelPending}
          selectedEffort={remote.selectedEffort}
          selectedPermissionMode={remote.selectedPermissionMode}
          permissionModeStatus={remote.permissionModeStatus}
          phase={remote.phase}
          phaseDetail={remote.phaseDetail}
          running={remote.running}
          canInterrupt={remote.canInterrupt}
          canSteer={remote.canSteer}
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
          checkSync={remote.checkConversationSync}
          onUseInbox={file => {
            setInboxSelection({ file });
            setHomePage('projects');
          }}
          connectionUrl={remote.connectionUrl}
          phase={remote.phase}
          detail={phaseDetail}
          onReconnect={remote.reconnect}
          onSettings={() => setShowSettings(true)}
          footer={homeNav}
          notice={notice} />
      ) : (
        <ThreadList
          attention={remote.threadAttention}
          position={threadListPosition}
          onArchives={remote.archiveSupported ? () => setArchiveTarget('list') : undefined}
          quota={<AccountUsagePanel usage={remote.usage} status={remote.usageStatus} refresh={remote.refreshUsage} expanded />}
          onOpenQuota={remote.refreshUsage}
          onArchive={remote.archiveSupported ? thread => setArchiveTarget({ id: thread.id, title: thread.title }) : undefined}
          hidden={hidden}
          hiddenThreads={hiddenThreads}
          removed={removed}
          threads={remote.threads}
          phase={remote.phase}
          phaseDetail={phaseDetail}
          onSelect={openRootThread}
          onCreate={cwd => { setNewDirectory(cwd); setShowNewThread(true); if (remote.desktopProjectMenus) remote.refreshProjects(); }}
          footer={homeNav}
          notice={notice}
          onSettings={() => setShowSettings(true)}
          onReconnect={remote.reconnect}
        />
      )}

      {taskPowerThreadId && taskPowerThreadId === remote.selectedThreadId &&
        <DevicePowerDialog config={config} phase={remote.phase} threadId={taskPowerThreadId} onClose={() => setTaskPowerThreadId(null)} />}
      {archiveTarget && <ArchiveDialog target={archiveTarget} connected={remote.phase === 'connected'} request={remote.archiveRequest} onClose={() => setArchiveTarget(null)} />}
      {showNewThread && (
        <NewThreadSheet initialDirectory={newDirectory} desktopOnly={remote.desktopOnly}
          projectMenus={remote.desktopProjectMenus} projectStatus={remote.projectStatus}
          directories={remote.desktopProjectMenus ? remote.desktopProjects.map(p => p.path).filter(showDirectory) :
            [...new Set(remote.threads.filter(thread => !thread.projectless).map(thread => thread.cwd).filter(showDirectory))]}
          models={remote.models} defaultModel={remote.selectedModel} onClose={() => setShowNewThread(false)} onStart={remote.startThread} />
      )}

    </>
  );
}
