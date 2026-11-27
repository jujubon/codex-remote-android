using System;
using System.Diagnostics;
using System.IO;

internal static class DesktopWatchLauncher
{
    private static int Main()
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        string script = Path.Combine(directory, "Watch-CodexDesktop.ps1");
        try
        {
            var start = new ProcessStartInfo(powershell)
            {
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process watcher = Process.Start(start))
            {
                watcher.WaitForExit();
                return watcher.ExitCode;
            }
        }
        catch (Exception error)
        {
            File.AppendAllText(Path.Combine(directory, "watch.log"),
                DateTimeOffset.Now.ToString("o") + " Watcher start failed (" + error.GetType().Name + ")." + Environment.NewLine);
            return 1;
        }
    }
}
