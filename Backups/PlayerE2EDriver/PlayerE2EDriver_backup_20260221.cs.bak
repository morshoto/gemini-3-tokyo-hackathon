using System;
using System.Globalization;
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

[RequireComponent(typeof(CharacterController))]
public class PlayerE2EDriver : MonoBehaviour
{
    public bool botEnabled = false;
    public string pendingCommand;
    public string lastObservationJson;

    [Header("References")]
    [SerializeField] CharacterController characterController;

    [Header("E2E / Gemini")]
    [SerializeField] string serverUrl = "http://localhost:3000/decide";
    [SerializeField] float queryInterval = 0.5f;

    [Header("Move Parameters")]
    [SerializeField] float moveSpeed = 3.0f;
    [SerializeField] float turnSpeedDeg = 120.0f;
    [SerializeField] float jumpSpeed = 5.0f;
    [SerializeField] float gravity = -9.81f;

    [Header("Sensors")]
    [SerializeField] float rayDistance = 5.0f;

    enum ActionType
    {
        None,
        MoveForward,
        MoveBack,
        TurnLeft,
        TurnRight,
        Jump
    }

    ActionType _currentAction = ActionType.None;
    float _actionTimeRemaining;
    float _actionAngleRemaining;
    float _verticalVelocity;
    bool _queryRunning;

    void Awake()
    {
        if (characterController == null)
            characterController = GetComponent<CharacterController>();
        if (characterController == null)
            characterController = gameObject.AddComponent<CharacterController>();
    }

    void Update()
    {
        if (botEnabled)
        {
            TickActions();
            TryStartQuery();
        }

        UpdateObservationJson();
    }

    void TickActions()
    {
        if (_currentAction == ActionType.None)
        {
            TryConsumeCommand();
        }

        Vector3 moveDir = Vector3.zero;

        switch (_currentAction)
        {
            case ActionType.MoveForward:
                moveDir = transform.forward;
                break;
            case ActionType.MoveBack:
                moveDir = -transform.forward;
                break;
            case ActionType.TurnLeft:
                StepTurn(-1f);
                break;
            case ActionType.TurnRight:
                StepTurn(1f);
                break;
            case ActionType.Jump:
                if (characterController.isGrounded)
                {
                    _verticalVelocity = jumpSpeed;
                }
                _currentAction = ActionType.None;
                break;
        }

        if (_actionTimeRemaining > 0f)
        {
            _actionTimeRemaining -= Time.deltaTime;
            if (_actionTimeRemaining <= 0f)
            {
                _actionTimeRemaining = 0f;
                _currentAction = ActionType.None;
            }
        }

        ApplyMovement(moveDir);
    }

    void ApplyMovement(Vector3 moveDir)
    {
        if (characterController.isGrounded && _verticalVelocity < 0f)
        {
            _verticalVelocity = -1f;
        }

        _verticalVelocity += gravity * Time.deltaTime;
        Vector3 velocity = moveDir * moveSpeed;
        velocity.y = _verticalVelocity;

        characterController.Move(velocity * Time.deltaTime);
    }

    void StepTurn(float direction)
    {
        if (_actionAngleRemaining <= 0f)
        {
            _currentAction = ActionType.None;
            return;
        }

        float step = turnSpeedDeg * Time.deltaTime;
        float applied = Mathf.Min(step, _actionAngleRemaining);
        transform.Rotate(0f, direction * applied, 0f);
        _actionAngleRemaining -= applied;
        if (_actionAngleRemaining <= 0f)
        {
            _currentAction = ActionType.None;
        }
    }

    void TryConsumeCommand()
    {
        if (string.IsNullOrWhiteSpace(pendingCommand))
            return;

        string cmd = pendingCommand.Trim();
        pendingCommand = string.Empty;

        string[] parts = cmd.Split(':');
        string head = parts[0].Trim().ToLowerInvariant();
        string arg = parts.Length > 1 ? parts[1].Trim() : string.Empty;

        switch (head)
        {
            case "move_fwd":
                if (float.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out float fwdTime))
                {
                    _currentAction = ActionType.MoveForward;
                    _actionTimeRemaining = Mathf.Max(0f, fwdTime);
                }
                else
                {
                    Debug.LogWarning("[PlayerE2EDriver] move_fwd requires seconds. Example: move_fwd:1.5");
                }
                break;
            case "move_back":
                if (float.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out float backTime))
                {
                    _currentAction = ActionType.MoveBack;
                    _actionTimeRemaining = Mathf.Max(0f, backTime);
                }
                else
                {
                    Debug.LogWarning("[PlayerE2EDriver] move_back requires seconds. Example: move_back:1.0");
                }
                break;
            case "turn_left":
                if (float.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out float leftDeg))
                {
                    _currentAction = ActionType.TurnLeft;
                    _actionAngleRemaining = Mathf.Max(0f, leftDeg);
                }
                else
                {
                    Debug.LogWarning("[PlayerE2EDriver] turn_left requires degrees. Example: turn_left:45");
                }
                break;
            case "turn_right":
                if (float.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out float rightDeg))
                {
                    _currentAction = ActionType.TurnRight;
                    _actionAngleRemaining = Mathf.Max(0f, rightDeg);
                }
                else
                {
                    Debug.LogWarning("[PlayerE2EDriver] turn_right requires degrees. Example: turn_right:90");
                }
                break;
            case "jump":
                _currentAction = ActionType.Jump;
                break;
            default:
                Debug.LogWarning($"[PlayerE2EDriver] Unknown command: {cmd}");
                break;
        }
    }

    void TryStartQuery()
    {
        if (_queryRunning)
            return;
        if (!string.IsNullOrEmpty(pendingCommand))
            return;
        if (string.IsNullOrEmpty(lastObservationJson))
            return;
        StartCoroutine(QueryServerRoutine());
    }

    IEnumerator QueryServerRoutine()
    {
        _queryRunning = true;

        byte[] bodyRaw = System.Text.Encoding.UTF8.GetBytes(lastObservationJson);
        using (var req = new UnityWebRequest(serverUrl, "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(bodyRaw);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");

            yield return req.SendWebRequest();

            if (req.result == UnityWebRequest.Result.Success)
            {
                var json = req.downloadHandler.text;
                if (!string.IsNullOrWhiteSpace(json))
                {
                    var response = JsonUtility.FromJson<CommandResponse>(json);
                    if (!string.IsNullOrWhiteSpace(response.command))
                    {
                        pendingCommand = response.command.Trim();
                    }
                }
            }
            else
            {
                Debug.LogWarning("[PlayerE2EDriver] server error: " + req.error);
            }
        }

        yield return new WaitForSeconds(queryInterval);
        _queryRunning = false;
    }

    void UpdateObservationJson()
    {
        Observation obs = new Observation
        {
            time = Time.time,
            position = transform.position,
            yaw = transform.eulerAngles.y,
            forwardHit = CastDistance(transform.forward),
            leftHit = CastDistance(-transform.right),
            rightHit = CastDistance(transform.right)
        };

        lastObservationJson = JsonUtility.ToJson(obs);
    }

    float CastDistance(Vector3 dir)
    {
        if (Physics.Raycast(transform.position, dir, out RaycastHit hit, rayDistance))
        {
            return hit.distance;
        }

        return -1f;
    }

    [Serializable]
    struct Observation
    {
        public float time;
        public Vector3 position;
        public float yaw;
        public float forwardHit;
        public float leftHit;
        public float rightHit;
    }

    [Serializable]
    struct CommandResponse
    {
        public string command;
    }
}
