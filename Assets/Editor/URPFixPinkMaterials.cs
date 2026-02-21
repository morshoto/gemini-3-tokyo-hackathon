using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public static class URPFixPinkMaterials
{
    private const string ScenePath = "Assets/Scenes/SampleScene.unity";
    private const string PipelineAssetPath = "Assets/StarterAssets/Settings/High_PipelineAsset.asset";
    private static readonly Color DarkBaseColor = new Color(0.078f, 0.098f, 0.133f, 1f); // #141922

    [MenuItem("Tools/URP/Fix Pink Materials")]
    public static void FixPinkMaterials()
    {
        var report = new StringBuilder();

        // 1) Load URP asset
        var urpAsset = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelineAssetPath);
        if (urpAsset == null)
        {
            report.AppendLine("URP asset not found at: " + PipelineAssetPath);
            WriteReport(report);
            return;
        }

        // 2) Wire into Project Settings (Graphics + Quality current level)
        GraphicsSettings.renderPipelineAsset = urpAsset;
        QualitySettings.renderPipeline = urpAsset;
        QualitySettings.SetQualityLevel(QualitySettings.GetQualityLevel(), true);

        report.AppendLine("Graphics SRP Asset: " + AssetDatabase.GetAssetPath(urpAsset));
        report.AppendLine("Quality Level: " + QualitySettings.names[QualitySettings.GetQualityLevel()]);
        report.AppendLine("Quality SRP Asset: " + AssetDatabase.GetAssetPath(QualitySettings.renderPipeline));

        // 3) Open scene
        var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        report.AppendLine("Scene Loaded: " + scene.path);

        // 4) Collect targets
        FixObjectByName("Plane", report);
        FixObjectByName("Structure_Mesh", report);
        FixObjectByName("Stairs_650_400_300_Mesh", report, includeChildren:true);
        FixObjectByName("Stairs_200_100_200_Mesh", report);
        FixMazeRoot(report);
        FixObjectByName("PlayerCapsule", report, includeChildren:true);

        // 5) Save
        EditorSceneManager.MarkSceneDirty(scene);
        EditorSceneManager.SaveScene(scene);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        // 6) Verification snapshot
        AppendRendererReport("Plane", report);
        AppendRendererReport("MazeRoot/Wall_A", report);

        WriteReport(report);
    }

    private static void FixMazeRoot(StringBuilder report)
    {
        var maze = GameObject.Find("MazeRoot");
        if (maze == null)
        {
            report.AppendLine("MazeRoot not found.");
            return;
        }

        var renderers = maze.GetComponentsInChildren<Renderer>(true);
        foreach (var r in renderers)
            FixRendererMaterials(r, report);
    }

    private static void FixObjectByName(string name, StringBuilder report, bool includeChildren = false)
    {
        var go = GameObject.Find(name);
        if (go == null)
        {
            report.AppendLine(name + " not found.");
            return;
        }

        if (includeChildren)
        {
            foreach (var r in go.GetComponentsInChildren<Renderer>(true))
                FixRendererMaterials(r, report);
        }
        else
        {
            var r = go.GetComponent<Renderer>();
            if (r != null)
                FixRendererMaterials(r, report);
        }
    }

    private static void FixRendererMaterials(Renderer r, StringBuilder report)
    {
        if (r == null) return;
        var mats = r.sharedMaterials;
        if (mats == null || mats.Length == 0) return;

        for (int i = 0; i < mats.Length; i++)
        {
            var mat = mats[i];
            if (mat == null) continue;

            var shaderName = mat.shader != null ? mat.shader.name : "<null>";
            if (!shaderName.StartsWith("Universal Render Pipeline"))
            {
                var urpShader = Shader.Find("Universal Render Pipeline/Lit");
                if (urpShader != null)
                    mat.shader = urpShader;
            }

            if (mat.HasProperty("_BaseMap"))
            {
                var baseMap = mat.GetTexture("_BaseMap");
                if (baseMap == null && mat.HasProperty("_BaseColor"))
                    mat.SetColor("_BaseColor", DarkBaseColor);
            }
            else if (mat.HasProperty("_BaseColor"))
            {
                mat.SetColor("_BaseColor", DarkBaseColor);
            }

            if (mat.HasProperty("_Color") && !mat.HasProperty("_BaseColor"))
                mat.SetColor("_Color", DarkBaseColor);
        }
    }

    private static void AppendRendererReport(string pathOrName, StringBuilder report)
    {
        GameObject go = GameObject.Find(pathOrName);
        if (go == null)
        {
            report.AppendLine("Verify: " + pathOrName + " not found.");
            return;
        }

        var r = go.GetComponent<Renderer>();
        if (r == null)
        {
            report.AppendLine("Verify: " + pathOrName + " has no Renderer.");
            return;
        }

        report.AppendLine("Verify: " + pathOrName);
        foreach (var m in r.sharedMaterials)
        {
            if (m == null)
            {
                report.AppendLine("  - <null material>");
                continue;
            }
            var s = m.shader != null ? m.shader.name : "<null shader>";
            report.AppendLine("  - " + m.name + " | " + s);
        }
    }

    private static void WriteReport(StringBuilder report)
    {
        var path = "Assets/Editor/URPFixReport.txt";
        File.WriteAllText(path, report.ToString());
        AssetDatabase.Refresh();
    }
}
