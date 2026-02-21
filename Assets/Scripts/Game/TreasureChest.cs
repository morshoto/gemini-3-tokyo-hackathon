using UnityEngine;

/// <summary>
/// Marks a chest as found when the player enters its trigger.
/// </summary>
[RequireComponent(typeof(Collider))]
public class TreasureChest : MonoBehaviour
{
    public string chestId;
    public bool found { get; private set; }

    private void Awake()
    {
        var col = GetComponent<Collider>();
        if (col != null)
        {
            col.isTrigger = true;
        }

        if (string.IsNullOrWhiteSpace(chestId))
        {
            chestId = gameObject.name;
        }

        TreasureChestManager.GetOrCreate().Register(this);
    }

    private void OnDestroy()
    {
        if (TreasureChestManager.TryGetInstance(out var manager))
        {
            manager.Unregister(this);
        }
    }

    private void OnTriggerEnter(Collider other)
    {
        if (!other.CompareTag("Player"))
        {
            return;
        }

        MarkFound();
    }

    public void MarkFound()
    {
        if (found)
        {
            return;
        }

        found = true;
        if (TreasureChestManager.TryGetInstance(out var manager))
        {
            manager.NotifyFound(this);
        }

        Debug.Log($"[PlayerE2E] Chest found at <{transform.position.x:F2},{transform.position.y:F2},{transform.position.z:F2}> id={chestId}");

        var renderer = GetComponentInChildren<Renderer>();
        if (renderer != null)
        {
            renderer.enabled = false;
        }
    }
}
