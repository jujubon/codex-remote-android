"""Open or create a conversation in the user's already running Codex Desktop."""
import json
import os
import re
import subprocess
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / 'native'))
from desktop_control import DesktopControlError, WindowsDesktopPipe, pipe_server_identity
from native_app_tools import NativeAppTools
from endpoint_hint import discover_native_endpoints


def current_desktop_tools(required_tools=('read_thread', 'send_message_to_thread')):
    # WindowsApps is managed by MSIX; the pipe name alone never establishes identity.
    packages = Path(os.environ['ProgramFiles']) / 'WindowsApps'
    required = set(required_tools)
    for path in discover_native_endpoints():
        if 'codex-app-tools-' not in path:
            continue
        try:
            with WindowsDesktopPipe(1.5, path=path) as pipe:
                ident, _, image = pipe_server_identity(pipe)
            relative = Path(image).resolve(strict=True).relative_to(packages)
            if (len(relative.parts) != 3
                    or not re.fullmatch(r'OpenAI\.Codex_[0-9.]+_(?:x64|arm64)__2p2nqsd0c76g0', relative.parts[0], re.I)
                    or relative.parts[1].lower() != 'app' or relative.name.lower() not in ('chatgpt.exe', 'codex.exe')):
                continue
            tools = NativeAppTools(endpoint=path)
            if required <= tools.capabilities(ident):
                return tools, ident
        except (OSError, ValueError, TimeoutError, DesktopControlError):
            continue
    raise ValueError('verified-desktop-tools-unavailable')


def project_desktop_tools(required_tools):
    try:
        return current_desktop_tools(required_tools)
    except ValueError:
        # Older Desktop builds can still authenticate their app-tools through the legacy pipe.
        with WindowsDesktopPipe() as pipe:
            identity, _, _ = pipe_server_identity(pipe)
        return NativeAppTools(), identity


def find_project(projects, directory):
    path = os.path.normcase(os.path.normpath(directory))
    matches = [p for p in projects if p['path'] and os.path.normcase(os.path.normpath(p['path'])) == path]
    if len(matches) > 1:
        raise ValueError('电脑上有多个项目指向同一目录，请在电脑端核对。')
    return matches[0] if matches else None


def new_project(name, get_projects):
    if (not isinstance(name, str) or not name or len(name) > 100 or name != name.strip()
            or name.endswith('.') or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            or re.fullmatch(r'(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])(?:\..*)?', name, re.I)):
        raise ValueError('请输入有效的 Windows 文件夹名称，不能包含路径。')
    root = Path.home() / 'CodexProjects'
    path = root / name
    if path.resolve().parent != root.resolve():
        raise ValueError('项目必须位于 CodexProjects 目录下。')
    if find_project(get_projects(), path):
        raise ValueError('同名项目已存在，请选择「已有项目」。')
    root.mkdir(exist_ok=True)
    try:
        path.mkdir()
    except FileExistsError:
        if not path.is_dir() or any(path.iterdir()):
            raise ValueError('此名称已被电脑上的文件或非空目录使用，请换一个项目名称。')
    try:
        subprocess.run([os.environ.get('CODEX_BIN') or 'codex.exe', 'app', '--', str(path)],
                       check=True, timeout=15, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        raise ValueError(f'目录已准备好，但电脑未确认打开项目：{path}。请检查 Codex Desktop。') from None
    deadline = time.monotonic() + 12
    while True:
        project = find_project(get_projects(), path)
        if project:
            return project
        if time.monotonic() >= deadline:
            raise ValueError(f'目录已准备好：{path}。桌面尚未列出该项目，请在电脑端确认打开后从「已有项目」继续。首条消息尚未发送。')
        time.sleep(0.4)


def run(request):
    if request['action'] == 'projects':
        try:
            tools, identity = project_desktop_tools(('read_thread', 'list_projects'))
            projects = tools.projects(request['threadId'], identity)
        except (OSError, ValueError, TimeoutError, DesktopControlError):
            return {'state': 'rejected', 'reply': '暂时无法读取电脑项目。请保持 Codex Desktop 打开，再重新打开「新聊天」。'}
        return {'state': 'confirmed', 'projects': [
            {'path': project['path'], 'name': project['name']} for project in projects if project['path']
        ]}
    if request['action'] == 'native-project-create':
        try:
            tools, identity = current_desktop_tools(('read_thread', 'list_projects'))
            project = new_project(request.get('projectName'), lambda: tools.projects(request['threadId'], identity))
        except ValueError as error:
            return {'state': 'rejected', 'reply': str(error)}
        return {'state': 'confirmed', 'project': project}
    if request['action'] == 'native-archive':
        try:
            tools, identity = current_desktop_tools(('read_thread', 'set_thread_archived'))
            return tools.archive_thread(request['threadId'], identity, uuid.uuid4().hex)
        except (OSError, ValueError, TimeoutError, DesktopControlError):
            return {'state': 'rejected', 'reply': '对话仍被 Codex 占用，暂时无法通过桌面归档。请稍后重试。'}
    if request['action'] == 'native-rename':
        try:
            tools, identity = current_desktop_tools(('read_thread', 'set_thread_title'))
        except (OSError, ValueError, TimeoutError, DesktopControlError):
            return {'state': 'rejected', 'code': 'desktop_rename_unavailable', 'reply': '桌面改名接口暂不可用。'}
        result = tools.rename(request['threadId'], request['title'], identity, uuid.uuid4().hex)
        if result.get('state') == 'confirmed':
            return {**result, 'thread_id': request['threadId']}
        return {'state': result.get('state', 'unknown'), 'reply': '桌面未确认新标题，请刷新对话后核对。'}
    if request['action'] in ('native-send', 'native-read', 'native-model-check'):
        try:
            tools, identity = current_desktop_tools()
            thread = request['threadId']
            if request['action'] == 'native-read':
                return {'state': 'confirmed', 'snapshot': tools.thread_snapshot(thread, identity)}
            if request['action'] == 'native-model-check':
                return tools.check_model_override(thread, identity, request['model'], request.get('thinking'))
        except Exception:
            return {'state': 'rejected', 'reply': '新版桌面接口暂不可用，请检查 Codex Desktop。'}
        return tools.send_text(thread, request['prompt'], identity, uuid.uuid4().hex,
                               model=request.get('model'), thinking=request.get('thinking'))
    thread = request['threadId']
    operation = uuid.uuid4().hex
    if request['action'] == 'open':
        with WindowsDesktopPipe() as pipe:
            identity, _, _ = pipe_server_identity(pipe)
        return NativeAppTools().open_thread(thread, identity, operation)
    if request['action'] != 'create':
        raise ValueError('unknown action')
    prompt = request.get('prompt')
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 4000:
        return {'state': 'rejected', 'reply': '首条消息需要 1 至 4000 个字符。'}
    required_tools = ['read_thread', 'create_thread']
    if request.get('destination') != 'projectless':
        required_tools.append('list_projects')
    tools, identity = project_desktop_tools(required_tools)
    def get_projects():
        return tools.projects(thread, identity)
    try:
        if request.get('destination') == 'projectless':
            project = {'id': None, 'name': '无项目', 'path': None}
        elif request.get('destination') == 'newProject':
            project = new_project(request.get('projectName'), get_projects)
        else:
            project = find_project(get_projects(), request['cwd'])
        if not project:
            raise ValueError('请从桌面已有项目中选择。')
    except ValueError as error:
        return {'state': 'rejected', 'reply': str(error)}
    return tools.create(thread, project, prompt, None, identity, operation)


if __name__ == '__main__':
    try:
        result = run(json.load(sys.stdin))
    except Exception as error:
        result = {'state': 'unknown', 'reply': '无法确认桌面操作，请刷新对话。', 'error': type(error).__name__}
    print(json.dumps(result, ensure_ascii=True))
