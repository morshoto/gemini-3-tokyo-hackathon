using System;
using UnityEngine;

/// <summary>
/// Unity 側の「E2E テスト用プレイヤードライバ」
/// - inspector の pendingCommand に "move_fwd:1.0" などを書くとそのとおり動く
/// - botEnabled が true のときだけコマンドを実行
/// - lastObservationJson に毎フレーム観測情報を JSON で入れる
/// </summary>
[RequireComponent(typeof(CharacterController))]
public class PlayerE2EDriver : MonoBehaviour
{
    private const int ObsLogEveryNFrames = 60;
    private const string ChestTag = "Chest";
    private const float ChestDetectRadius = 6f;

    [Header("Bot")]
    public bool botEnabled = false;
    public string pendingCommand = "";
    [TextArea(1, 6)]
    public string lastObservationJson = "";

    [Header("References")]
    public CharacterController characterController;

    [Header("Move Parameters")]
    public float moveSpeed = 3f;
    public float turnSpeedDeg = 120f;
    public float jumpSpeed = 5f;
    public float gravity = -9.81f;

    [Header("Sensors")]
    public float rayDistance = 5f;

    // 内部状態
    private float _verticalVelocity = 0f;

    private bool _commandActive = false;
    private string _currentCommand = "";
    private float _commandParam = 0f;   // 秒 or 角度
    private float _commandTimer = 0f;

    [Serializable]
    private class Observation
    {
        public float time;
        public Vector3 position;
        public Vector3 rotation;
        public float yaw;
        public float forwardHit;
        public float leftHit;
        public float rightHit;
        public int totalChests;
        public int chestsFound;
        public float nearestChestDistance;
    }

    private void Awake()
    {
        if (characterController == null)
        {
            characterController = GetComponent<CharacterController>();
        }
    }

    private void Update()
    {
        UpdateObservation();

        if (!botEnabled)
        {
            // bot 無効中でも重力だけは適用しておく
            ApplyGravityAndMove(Vector3.zero);
            return;
        }

        // コマンドが走っていない && pendingCommand に何か入っていたらパース
        if (!_commandActive && !string.IsNullOrWhiteSpace(pendingCommand))
        {
            TryStartCommand(pendingCommand);
            // 一度読んだらクリア
            pendingCommand = "";
        }

        // 実行中のコマンドがあれば処理
        if (_commandActive)
        {
            ExecuteCurrentCommand();
        }
        else
        {
            // コマンドが無ければその場で重力だけ
            ApplyGravityAndMove(Vector3.zero);
        }
    }

    private void TryStartCommand(string cmd)
    {
        cmd = cmd.Trim();
        _currentCommand = "";
        _commandParam = 0f;
        _commandTimer = 0f;
        _commandActive = false;

        // move_fwd:1.0 形式
        if (cmd.StartsWith("move_fwd:", StringComparison.OrdinalIgnoreCase))
        {
            if (float.TryParse(cmd.Substring("move_fwd:".Length), out var seconds))
            {
                _currentCommand = "move_fwd";
                _commandParam = Mathf.Max(0f, seconds);
                _commandTimer = _commandParam;
                _commandActive = _commandTimer > 0f;
            }
            return;
        }

        if (cmd.StartsWith("move_back:", StringComparison.OrdinalIgnoreCase))
        {
            if (float.TryParse(cmd.Substring("move_back:".Length), out var seconds))
            {
                _currentCommand = "move_back";
                _commandParam = Mathf.Max(0f, seconds);
                _commandTimer = _commandParam;
                _commandActive = _commandTimer > 0f;
            }
            return;
        }

        if (cmd.StartsWith("turn_left:", StringComparison.OrdinalIgnoreCase))
        {
            if (float.TryParse(cmd.Substring("turn_left:".Length), out var deg))
            {
                _currentCommand = "turn_left";
                _commandParam = deg;
                _commandTimer = Mathf.Abs(_commandParam) / turnSpeedDeg;
                _commandActive = _commandTimer > 0f;
            }
            return;
        }

        if (cmd.StartsWith("turn_right:", StringComparison.OrdinalIgnoreCase))
        {
            if (float.TryParse(cmd.Substring("turn_right:".Length), out var deg))
            {
                _currentCommand = "turn_right";
                _commandParam = deg;
                _commandTimer = Mathf.Abs(_commandParam) / turnSpeedDeg;
                _commandActive = _commandTimer > 0f;
            }
            return;
        }

        if (string.Equals(cmd, "jump", StringComparison.OrdinalIgnoreCase))
        {
            _currentCommand = "jump";
            _commandParam = 0f;
            _commandTimer = 0.2f; // 適当なジャンプ期間
            _commandActive = true;
            return;
        }

        // どれにもマッチしなければ何もしない
        Debug.Log($"[PlayerE2EDriver] Unknown command: {cmd}");
    }

    private void ExecuteCurrentCommand()
    {
        _commandTimer -= Time.deltaTime;
        if (_commandTimer <= 0f)
        {
            // 最後のフレームを処理して終了
            FinishCommand();
            _commandActive = false;
            return;
        }

        Vector3 move = Vector3.zero;

        switch (_currentCommand)
        {
            case "move_fwd":
                move = transform.forward * moveSpeed;
                break;
            case "move_back":
                move = -transform.forward * moveSpeed;
                break;
            case "turn_left":
            {
                float sign = _commandParam >= 0f ? 1f : -1f;
                float delta = sign * turnSpeedDeg * Time.deltaTime;
                transform.Rotate(0f, delta, 0f);
                break;
            }
            case "turn_right":
            {
                float sign = _commandParam >= 0f ? 1f : -1f;
                float delta = sign * turnSpeedDeg * Time.deltaTime;
                transform.Rotate(0f, -delta, 0f);
                break;
            }
            case "jump":
                if (characterController.isGrounded && _verticalVelocity <= 0f)
                {
                    _verticalVelocity = jumpSpeed;
                }
                break;
        }

        ApplyGravityAndMove(move);
    }

    private void FinishCommand()
    {
        // 回転コマンドは残り角度を一気に解消しても良いが、
        // ここでは特に何もせず終了とする
    }

    private void ApplyGravityAndMove(Vector3 horizontalVelocity)
    {
        if (characterController == null)
        {
            characterController = GetComponent<CharacterController>();
            if (characterController == null) return;
        }

        // 重力
        if (characterController.isGrounded && _verticalVelocity < 0f)
        {
            _verticalVelocity = -1f; // 地面に押し付ける
        }
        else
        {
            _verticalVelocity += gravity * Time.deltaTime;
        }

        Vector3 velocity = horizontalVelocity;
        velocity.y = _verticalVelocity;

        characterController.Move(velocity * Time.deltaTime);
    }

    private void UpdateObservation()
    {
        var obs = new Observation();
        obs.time = Time.time;
        obs.position = transform.position;
        obs.rotation = transform.eulerAngles;
        obs.yaw = transform.eulerAngles.y;

        obs.forwardHit = CastRay(transform.forward);
        obs.leftHit    = CastRay(-transform.right);
        obs.rightHit   = CastRay(transform.right);

        UpdateChestCounts(out obs.totalChests, out obs.chestsFound, out obs.nearestChestDistance);

        lastObservationJson = JsonUtility.ToJson(obs);

        if (Time.frameCount % ObsLogEveryNFrames == 0)
        {
            Debug.Log($"[PlayerE2E] obs position=<{obs.position.x:F2},{obs.position.z:F2}> chests={obs.chestsFound}/{obs.totalChests}");
        }
    }

    private void UpdateChestCounts(out int total, out int found, out float nearestDistance)
    {
        total = 0;
        found = 0;
        nearestDistance = -1f;

        var chests = GameObject.FindGameObjectsWithTag(ChestTag);
        if (chests == null || chests.Length == 0)
        {
            return;
        }

        total = chests.Length;
        float nearest = float.PositiveInfinity;

        for (int i = 0; i < chests.Length; i++)
        {
            var chest = chests[i];
            if (chest == null)
            {
                continue;
            }

            var chestComp = chest.GetComponent<TreasureChest>();
            bool isFound = chestComp != null && chestComp.found;
            if (isFound)
            {
                found++;
                continue;
            }

            float dist = Vector3.Distance(transform.position, chest.transform.position);
            if (dist < nearest)
            {
                nearest = dist;
            }
        }

        nearestDistance = float.IsPositiveInfinity(nearest) ? -1f : nearest;

        DetectNearbyChests();
        if (TreasureChestManager.TryGetInstance(out var manager))
        {
            found = manager.FoundChests;
        }
    }

    private void DetectNearbyChests()
    {
        Collider[] hits = Physics.OverlapSphere(transform.position, ChestDetectRadius);
        for (int i = 0; i < hits.Length; i++)
        {
            var col = hits[i];
            if (col == null || !col.CompareTag(ChestTag))
            {
                continue;
            }

            var chest = col.GetComponent<TreasureChest>();
            if (chest != null)
            {
                chest.MarkFound();
            }
        }
    }

    private float CastRay(Vector3 dir)
    {
        if (Physics.Raycast(transform.position + Vector3.up * 0.5f, dir, out RaycastHit hit, rayDistance))
        {
            return hit.distance;
        }
        return -1f;
    }
}
