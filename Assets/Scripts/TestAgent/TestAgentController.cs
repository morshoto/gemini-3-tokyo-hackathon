using UnityEngine;
using UnityEngine.AI;

[RequireComponent(typeof(NavMeshAgent))]
public class TestAgentController : MonoBehaviour
{
    [Header("Move settings")]
    public NavMeshAgent agent;
    [SerializeField] float wanderRadius = 20f;
    [SerializeField] float waitTime = 2f;

    [Header("Logging")]
    [SerializeField] float logInterval = 1.0f;

    [Header("STUCK detection")]
    [SerializeField] float stuckDistanceThreshold = 0.2f;
    [SerializeField] float stuckTimeThreshold = 5.0f;

    Vector3 _currentTarget;
    float _waitTimer;
    float _logTimer;

    Vector3 _lastPos;
    float _stuckTimer;

    void Awake()
    {
        if (agent == null)
            agent = GetComponent<NavMeshAgent>();
    }

    void Start()
    {
        _lastPos = transform.position;
        SetNewDestination();
    }

    void Update()
    {
        // 目的地に到達してしばらくしたら次の目的地
        if (!agent.pathPending && agent.remainingDistance <= agent.stoppingDistance)
        {
            _waitTimer += Time.deltaTime;
            if (_waitTimer >= waitTime)
            {
                _waitTimer = 0f;
                SetNewDestination();
            }
        }

        // STUCK 検出
        float moved = Vector3.Distance(transform.position, _lastPos);
        if (moved < stuckDistanceThreshold)
        {
            _stuckTimer += Time.deltaTime;
            if (_stuckTimer >= stuckTimeThreshold)
            {
                Debug.LogWarning($"[TestAgent][STUCK] pos={transform.position}, time={Time.time:F1}");
                _stuckTimer = 0f;
            }
        }
        else
        {
            _stuckTimer = 0f;
        }
        _lastPos = transform.position;

        // 状態ログ
        _logTimer += Time.deltaTime;
        if (_logTimer >= logInterval)
        {
            _logTimer = 0f;
            Debug.Log($"[TestAgent] t={Time.time:F1}, pos={transform.position}, dest={_currentTarget}, vel={agent.velocity.magnitude:F2}");
        }
    }

    void SetNewDestination()
    {
        for (int i = 0; i < 10; i++)
        {
            var randomDirection = Random.insideUnitSphere * wanderRadius;
            randomDirection.y = 0f;
            randomDirection += transform.position;

            if (NavMesh.SamplePosition(randomDirection, out var hit, wanderRadius, NavMesh.AllAreas))
            {
                _currentTarget = hit.position;
                agent.SetDestination(_currentTarget);
                Debug.Log($"[TestAgent] New target: {_currentTarget}");
                return;
            }
        }

        Debug.LogWarning("[TestAgent] 有効な目的地が見つかりませんでした");
    }
}
