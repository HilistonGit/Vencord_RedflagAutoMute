using System;
using System.Diagnostics;
using System.IO;

// Windows GUI subsystem: neither this launcher nor PowerShell allocates a console.
internal static class MaintenanceLauncher {
    [STAThread]
    private static int Main() {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        try {
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(directory, "maintenance.ps1") + "\"",
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch (Exception error) {
            try { File.AppendAllText(Path.Combine(directory, "launcher-error.log"), DateTime.UtcNow.ToString("o") + " " + error.Message + Environment.NewLine); } catch { }
            return 1;
        }
    }
}
