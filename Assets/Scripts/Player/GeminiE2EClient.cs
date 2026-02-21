using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

[DisallowMultipleComponent]
public class GeminiE2EClient : MonoBehaviour
{
    [Header("References")]
    public PlayerE2EDriver driver;

    [Header("Server Endpoints")]
    public string stepUrl = "http://localhost:3000/step";
    public string reportUrl = "http://localhost:3000/report";

    [Header("Loop Settings")]
    public float stepInterval = 1.0f;
    public int maxSteps = 200;

    private bool _running;
    private Coroutine _loop;

    [System.Serializable]
    private class StepRequest
    {
        public string observationJson;
    }

    [System.Serializable]
    private class StepResponse
    {
        public string command;
        public string note;
    }

    [System.Serializable]
    private class ReportRequest
    {
        public string dummy = "ok";
    }

    [System.Serializable]
    private class ReportResponse
    {
        public string reportMarkdown;
    }

    private void OnEnable()
    {
        if (driver == null)
        {
            driver = GetComponent<PlayerE2EDriver>();
        }

        _running = false;
        _loop = null;

        // If the bot is already enabled, start immediately
        if (driver != null && driver.botEnabled)
        {
            _loop = StartCoroutine(E2ELoop());
            _running = true;
            Debug.Log("[GeminiE2E] Loop started (auto on enable)");
        }
    }

    private void OnDisable()
    {
        if (_running && _loop != null)
        {
            StopCoroutine(_loop);
        }

        _running = false;
        _loop = null;
    }

    private void Update()
    {
        if (driver == null)
            return;

        // TEMP: debug to confirm Update is running
        Debug.Log("[GeminiE2E] Update tick");

        // Simple spec: as soon as botEnabled is true, run the loop.
        if (driver.botEnabled && !_running)
        {
            _loop = StartCoroutine(E2ELoop());
            _running = true;
            Debug.Log("[GeminiE2E] Loop started (simple)");
        }
        else if (!driver.botEnabled && _running)
        {
            if (_loop != null)
                StopCoroutine(_loop);

            _loop = null;
            _running = false;
            Debug.Log("[GeminiE2E] Loop stopped (simple)");
        }
    }

    private IEnumerator E2ELoop()
    {
        int steps = 0;

        while (driver != null && driver.botEnabled && steps < maxSteps)
        {
            string obs = driver.lastObservationJson;

            if (!string.IsNullOrEmpty(obs))
            {
                Debug.Log($"[GeminiE2E] STEP request, obs length={obs.Length}");

                StepRequest reqBody = new StepRequest { observationJson = obs };
                string json = JsonUtility.ToJson(reqBody);

                using (UnityWebRequest req = BuildJsonPost(stepUrl, json))
                {
#if UNITY_2020_2_OR_NEWER
                    yield return req.SendWebRequest();
                    bool hasError = req.result == UnityWebRequest.Result.ConnectionError
                                    || req.result == UnityWebRequest.Result.ProtocolError;
#else
                    yield return req.SendWebRequest();
                    bool hasError = req.isNetworkError || req.isHttpError;
#endif
                    if (hasError)
                    {
                        Debug.LogError("[GeminiE2E] STEP error: " + req.error);
                    }
                    else
                    {
                        string text = req.downloadHandler.text;
                        StepResponse resp = null;
                        try
                        {
                            resp = JsonUtility.FromJson<StepResponse>(text);
                        }
                        catch
                        {
                            Debug.LogError("[GeminiE2E] STEP response JSON parse error: " + text);
                        }

                        if (resp != null)
                        {
                            Debug.Log($"[GeminiE2E] STEP response command={resp.command}, note={resp.note}");

                            if (!string.IsNullOrEmpty(resp.command))
                            {
                                driver.pendingCommand = resp.command;
                            }
                        }
                        else
                        {
                            Debug.LogWarning("[GeminiE2E] STEP response empty or invalid");
                        }
                    }
                }

                steps++;
            }
            else
            {
                Debug.Log("[GeminiE2E] STEP skipped (no observationJson yet)");
            }

            yield return new WaitForSeconds(stepInterval);
        }

        Debug.Log("[GeminiE2E] REPORT request");

        ReportRequest reportReq = new ReportRequest();
        string reportJson = JsonUtility.ToJson(reportReq);

        using (UnityWebRequest req = BuildJsonPost(reportUrl, reportJson))
        {
#if UNITY_2020_2_OR_NEWER
            yield return req.SendWebRequest();
            bool hasError = req.result == UnityWebRequest.Result.ConnectionError
                            || req.result == UnityWebRequest.Result.ProtocolError;
#else
            yield return req.SendWebRequest();
            bool hasError = req.isNetworkError || req.isHttpError;
#endif
            if (hasError)
            {
                Debug.LogError("[GeminiE2E] REPORT error: " + req.error);
            }
            else
            {
                string text = req.downloadHandler.text;
                ReportResponse resp = null;
                try
                {
                    resp = JsonUtility.FromJson<ReportResponse>(text);
                }
                catch
                {
                    // plain text case
                }

                if (resp != null && !string.IsNullOrEmpty(resp.reportMarkdown))
                {
                    Debug.Log($"[GeminiE2E] REPORT received, length={resp.reportMarkdown.Length}");
                    Debug.Log("===== GEMINI QA REPORT START =====\n" +
                              resp.reportMarkdown +
                              "\n===== GEMINI QA REPORT END =====");
                }
                else
                {
                    Debug.Log($"[GeminiE2E] REPORT received (raw), length={text.Length}");
                    Debug.Log("===== GEMINI QA REPORT START (RAW) =====\n" +
                              text +
                              "\n===== GEMINI QA REPORT END (RAW) =====");
                }
            }
        }

        _running = false;
        _loop = null;
        Debug.Log("[GeminiE2E] Loop finished");
    }

    private static UnityWebRequest BuildJsonPost(string url, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST);
        req.uploadHandler = new UploadHandlerRaw(bytes);
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "application/json");
        return req;
    }
}
