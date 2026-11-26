using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class CruxGuardianRunner {
  static Dictionary<string, object> ReadRecord(string file, int limit) {
    var info = new FileInfo(file);
    if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > limit) {
      throw new InvalidOperationException("invalid-record");
    }
    var json = new JavaScriptSerializer { MaxJsonLength = limit };
    var parsed = json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
    if (parsed == null) throw new InvalidOperationException("invalid-record");
    return parsed;
  }

  static void SaveRecord(string file, object value) {
    string temp = file + "." + Guid.NewGuid().ToString() + ".tmp";
    var json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(value));
    using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
    File.Move(temp, file);
  }

  static CruxLifecycleNative.Owner ParseOwner(object raw) {
    var dict = raw as Dictionary<string, object>;
    if (dict == null) throw new InvalidOperationException("launch-scope");
    return new CruxLifecycleNative.Owner {
      pid = Convert.ToInt32(dict["pid"]),
      startedAt = Convert.ToString(dict["startedAt"]),
      userId = Convert.ToString(dict["userId"]),
      executable = Convert.ToString(dict["executable"])
    };
  }

  static string[] ParseArgs(object raw) {
    var list = raw as IEnumerable;
    if (list == null) return new string[0];
    var result = new List<string>();
    foreach (object item in list) result.Add(Convert.ToString(item));
    return result.ToArray();
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 2) return 71;
    string mode = args[0];
    string specPath = args[1];
    if (mode != "guardian" && mode != "gui-guardian") return 71;

    CruxLifecycleNative.Guardian guardian = null;
    CruxLifecycleNative.CapturedProcess guiController = null;
    try {
      var spec = ReadRecord(specPath, 1048576);
      string nonce = Guid.Parse(Convert.ToString(spec["nonce"])).ToString();
      string prefix = mode == "gui-guardian" ? @"Global\CruxGui-" : @"Global\CruxDaemon-";
      int version = Convert.ToInt32(spec["version"]);
      string jobName = Convert.ToString(spec["jobName"]);
      if (version != 1 || !String.Equals(jobName, prefix + nonce, StringComparison.Ordinal)) {
        throw new InvalidOperationException("launch-scope");
      }
      var identity = spec["identity"] as Dictionary<string, object>;
      if (identity == null) throw new InvalidOperationException("launch-scope");

      if (mode == "gui-guardian") {
        guiController = CruxLifecycleNative.Capture(ParseOwner(spec["controller"]));
        if (guiController == null || !String.Equals(guiController.owner.userId, Convert.ToString(identity["userId"]), StringComparison.Ordinal)) {
          throw new InvalidOperationException("launch-scope");
        }
      }

      string executable = Convert.ToString(spec["executable"]);
      string[] childArgs = ParseArgs(spec["args"]);
      bool watchController = spec.ContainsKey("watchController") && Convert.ToBoolean(spec["watchController"]);

      guardian = new CruxLifecycleNative.Guardian(jobName, executable, childArgs, mode == "gui-guardian");
      var self = CruxLifecycleNative.Inspect(Process.GetCurrentProcess().Id);
      var proof = new Dictionary<string, object> {
        { "version", 1 },
        { "nonce", nonce },
        { "jobName", jobName },
        { "identity", identity },
        { "root", guardian.root.owner },
        { "guardian", self }
      };
      if (mode == "gui-guardian") proof["controller"] = guiController.owner;

      string dir = Path.GetDirectoryName(specPath);
      SaveRecord(Path.Combine(dir, "proof.json"), proof);
      guardian.Resume();

      while (!guardian.root.Exited && (!watchController || !guiController.Exited)) {
        Thread.Sleep(15);
      }
      guardian.job.Terminate();
      var clock = Stopwatch.StartNew();
      while (!guardian.job.Empty && clock.ElapsedMilliseconds < 10000) {
        Thread.Sleep(10);
      }
      SaveRecord(Path.Combine(dir, "exit.json"), new Dictionary<string, object> {
        { "version", 1 },
        { "nonce", nonce },
        { "root", guardian.root.owner },
        { "cleaned", guardian.job.Empty }
      });
    } catch (Exception ex) {
      try {
        string dir = Path.GetDirectoryName(specPath);
        if (!String.IsNullOrEmpty(dir)) {
          var diag = new Dictionary<string, object> {
            { "code", "native-exit-unconfirmed" },
            { "phase", "capture" },
            { "reason", "native-failure" }
          };
          var win32 = ex as Win32Exception;
          if (win32 != null) {
            diag["nativeError"] = win32.NativeErrorCode;
            if (win32.NativeErrorCode == 5) diag["reason"] = "access-denied";
          }
          SaveRecord(Path.Combine(dir, "failure.json"), new Dictionary<string, object> {
            { "version", 1 },
            { "code", "native-launch-failed" },
            { "diagnostic", diag }
          });
        }
      } catch { }
      return 71;
    } finally {
      if (guardian != null) guardian.Dispose();
      if (guiController != null) guiController.Dispose();
    }
    try { CruxLifecycleNative.FastExit(0); } catch { }
    return 0;
  }
}
