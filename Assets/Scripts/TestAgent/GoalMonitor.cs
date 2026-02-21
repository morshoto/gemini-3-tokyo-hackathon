using UnityEngine;

public class GoalMonitor : MonoBehaviour
{
    public Transform agentTransform;
    public Transform goalTransform;

    [SerializeField] float reachRadius = 1.5f;
    [SerializeField] float maxTimeToReach = 20f;

    float _timer;

    void Update()
    {
        if (agentTransform == null || goalTransform == null) return;

        _timer += Time.deltaTime;

        float dist = Vector3.Distance(agentTransform.position, goalTransform.position);
        if (dist <= reachRadius)
        {
            Debug.Log($"[TestAgent][GOAL_REACHED] dist={dist:F2}, time={_timer:F1}");
            enabled = false; // 1回達成したら監視終了
            return;
        }

        if (_timer >= maxTimeToReach)
        {
            Debug.LogWarning($"[TestAgent][GOAL_UNREACHABLE] dist={dist:F2}, time={_timer:F1}");
            enabled = false;
        }
    }
}
