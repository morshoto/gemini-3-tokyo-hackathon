using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Tracks all treasure chests in the scene and provides aggregate info for QA/telemetry.
/// </summary>
public class TreasureChestManager : MonoBehaviour
{
    public static TreasureChestManager Instance { get; private set; }

    private readonly List<TreasureChest> _chests = new List<TreasureChest>();
    private int _foundCount = 0;

    public int TotalChests => _chests.Count;
    public int FoundChests => _foundCount;

    public static TreasureChestManager GetOrCreate()
    {
        if (Instance != null)
        {
            return Instance;
        }

        var existing = FindObjectOfType<TreasureChestManager>();
        if (existing != null)
        {
            Instance = existing;
            return Instance;
        }

        var go = new GameObject("TreasureChestManager");
        go.hideFlags = HideFlags.HideInHierarchy;
        Instance = go.AddComponent<TreasureChestManager>();
        return Instance;
    }

    public static bool TryGetInstance(out TreasureChestManager manager)
    {
        if (Instance != null)
        {
            manager = Instance;
            return true;
        }

        manager = FindObjectOfType<TreasureChestManager>();
        if (manager != null)
        {
            Instance = manager;
            return true;
        }

        return false;
    }

    private void Awake()
    {
        if (Instance == null)
        {
            Instance = this;
        }
        else if (Instance != this)
        {
            Destroy(gameObject);
        }
    }

    public void Register(TreasureChest chest)
    {
        if (chest == null || _chests.Contains(chest))
        {
            return;
        }

        _chests.Add(chest);
        if (chest.found)
        {
            _foundCount++;
        }
    }

    public void Unregister(TreasureChest chest)
    {
        if (chest == null)
        {
            return;
        }

        if (_chests.Remove(chest) && chest.found)
        {
            _foundCount = Mathf.Max(0, _foundCount - 1);
        }
    }

    public void NotifyFound(TreasureChest chest)
    {
        if (chest == null)
        {
            return;
        }

        if (!_chests.Contains(chest))
        {
            _chests.Add(chest);
        }

        _foundCount = Mathf.Clamp(_foundCount + 1, 0, _chests.Count);
        Debug.Log($"[TreasureChestManager] Found {FoundChests}/{TotalChests} chests");
    }

    public float GetNearestUnfoundDistance(Vector3 fromPosition)
    {
        float min = float.PositiveInfinity;
        for (int i = 0; i < _chests.Count; i++)
        {
            var chest = _chests[i];
            if (chest == null || chest.found)
            {
                continue;
            }

            float dist = Vector3.Distance(fromPosition, chest.transform.position);
            if (dist < min)
            {
                min = dist;
            }
        }

        return float.IsPositiveInfinity(min) ? -1f : min;
    }
}
