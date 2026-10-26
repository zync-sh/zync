# Fixed local Engine GETs only. Full responses stay on the host; only security
# booleans, counts, controlled enums and container IDs enter the fact envelope.
# Each slot has its own protected label so normal sudo policies need no replay bypass.
# jq 1.6 reserves "label"; its filter uses a separate record_label binding.
docker_workload_request() {
    command -v curl >/dev/null 2>&1 || return 127
    command -v jq >/dev/null 2>&1 || return 127
    command -v head >/dev/null 2>&1 || return 127
    {
        protected curl --disable --silent --show-error --fail --max-time 3 --max-filesize 524288 --noproxy '*' --proto '=http' --unix-socket /var/run/docker.sock --request GET "$2"
        docker_workload_status=$?
        printf '\nZYNC-WORKLOAD-%s-%s-status:%s\n' "$sudo_nonce" "$label" "$docker_workload_status"
    # Consumers wait through an approved password prompt. The producer's shared
    # execution timeout starts after authentication; the overall run bounds waiting.
    } | head -c 524289 | jq --raw-input --slurp --compact-output --arg nonce "$sudo_nonce" --arg record_label "$label" --arg kind "$1" '
    def bounded_array($object; $key):
      if ($object | type) == "object" and ($object | has($key)) then
        $object[$key] as $value | if $value == null then []
        elif ($value | type) == "array" and ($value | length) <= 256 then $value else null end
      else null end;
    def flag($value): if ($value | type) == "boolean" then $value else null end;
    def number($value): if ($value | type) == "number" and $value == ($value | floor) and $value >= 0 and $value <= 9007199254740991 then $value else null end;
    def sharing($value): if ($value | type) == "string" and ($value | length) <= 128
      then ($value == "host" or ($value | startswith("container:"))) else null end;
    def sensitive($path): $path == "/" or any(["/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/root"][]; . as $prefix | $path == $prefix or ($path | startswith($prefix + "/")));
    def option_value($options; $key): reduce $options[] as $option (null;
      if ($option | startswith($key + "=")) or ($option | startswith($key + ":")) then $option[($key | length)+1:] else . end);
    def explicit_nnp($options): reduce $options[] as $option (false;
      if $option == "no-new-privileges" then true
      elif ($option | startswith("no-new-privileges=")) or ($option | startswith("no-new-privileges:")) then
        $option[18:] as $value | if ["1","t","T","TRUE","true","True"] | index($value) then true
          elif ["0","f","F","FALSE","false","False"] | index($value) then false else null end
      else . end);
    if utf8bytelength > 524288 then ("Workload response exceeded its limit" | halt_error(65))
    else split("\nZYNC-WORKLOAD-" + $nonce + "-" + $record_label + "-status:") as $parts
      | if ($parts | length) != 2 or ($parts[1] | test("^[0-9]{1,3}\n$") | not) then ("Workload response was incomplete" | halt_error(65))
        else ($parts[1] | tonumber) as $status
        | if $status > 255 then ("Workload response status was invalid" | halt_error(65))
          elif $status != 0 then ("Workload transfer failed" | halt_error($status))
          else (try ($parts[0] | fromjson) catch null) as $body
          | if $kind == "list" then
              if ($body | type) == "array" and ($body | length) <= 21
                 and all($body[]; (.Id | type) == "string" and (.Id | test("^[0-9a-f]{64}$")) and .State == "running")
                 and ([$body[].Id] | unique | length) == ($body | length)
              then {schema:1, ids:([$body[].Id] | sort | .[:20]), limited:(($body | length) > 20)}
              else ("Workload inventory was invalid" | halt_error(65)) end
            elif $kind == "item" then
              $body as $item
              | if ($item | type) != "object" or ($item.Id | type) != "string" or ($item.Id | test("^[0-9a-f]{64}$") | not)
                then ("Workload identity was invalid" | halt_error(65))
                else $item.HostConfig as $host
                  | bounded_array($host; "CapAdd") as $caps
                  | bounded_array($host; "SecurityOpt") as $options
                  | bounded_array($item; "Mounts") as $mounts
                  | bounded_array($host; "Devices") as $devices
                  | ($options != null and all($options[]; type == "string" and length <= 65536)) as $options_known
                  | ($mounts != null and all($mounts[]; type == "object" and (.Type == "bind" or .Type == "volume" or .Type == "tmpfs" or .Type == "npipe" or .Type == "cluster") and (.Type != "bind" or ((.Source | type) == "string" and (.Source | length) <= 4096 and (.RW | type) == "boolean")))) as $mounts_known
                  | {schema:1,id:$item.Id,running:flag($item.State.Running),
                     privileged:flag($host.Privileged),
                     addedCapabilities:(if $caps != null and all($caps[]; type == "string" and length > 0 and length <= 64 and test("^[A-Za-z0-9_]+$")) then ($caps | length) else null end),
                     pidShared:sharing($host.PidMode),ipcShared:sharing($host.IpcMode),
                     networkMode:(if ($host.NetworkMode | type) != "string" or ($host.NetworkMode | length) > 128 then null elif $host.NetworkMode == "host" then "host" elif ($host.NetworkMode | startswith("container:")) then "container" else "other" end),
                     readOnlyRootfs:flag($host.ReadonlyRootfs),
                     startupUser:(if ($item.Config.User | type) != "string" or ($item.Config.User | length) > 128 then null elif $item.Config.User == "" then "default-root" elif ($item.Config.User | test("^(root|0+)(:[A-Za-z0-9_.-]+)?$")) then "explicit-root" elif ($item.Config.User | test("^[0-9]{1,10}(:[A-Za-z0-9_.-]+)?$")) then "numeric" elif ($item.Config.User | test("^[A-Za-z_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_.-]+)?$")) then "named" else null end),
                     noNewPrivileges:(if $options_known then explicit_nnp($options) else null end),
                     unconfinedSecurity:(if $options_known then option_value($options;"seccomp") == "unconfined" or option_value($options;"apparmor") == "unconfined" or any($options[]; . == "disable" or . == "label=disable" or . == "label:disable") else null end),
                     sensitiveBindMounts:(if $mounts_known then ([$mounts[] | select(.Type == "bind" and (sensitive(.Source) or (.Source | endswith("/docker.sock"))))] | length) else null end),
                     deviceMappings:(if $devices != null then ($devices | length) else null end),
                     memoryLimited:(number($host.Memory) | if . == null then null else . > 0 end),
                     pidsLimited:(if ($host | type) != "object" or ($host | has("PidsLimit") | not) then null elif $host.PidsLimit == null then false elif ($host.PidsLimit | type) == "number" and $host.PidsLimit == ($host.PidsLimit | floor) and ($host.PidsLimit | fabs) <= 9007199254740991 then $host.PidsLimit > 0 else null end),
                     cpuLimited:(if number($host.NanoCpus) == null or (number($host.CpuQuota) == null and $host.CpuQuota != -1) then null else ($host.NanoCpus > 0 or $host.CpuQuota > 0) end),
                     userNamespace:(if ($host.UsernsMode | type) != "string" then null elif $host.UsernsMode == "" then "engine-default" elif $host.UsernsMode == "host" then "host" elif $host.UsernsMode == "private" then "private" else null end)}
                end
            else ("Unsupported workload projection" | halt_error(65)) end
          end
        end
    end'
}

docker_workload_list() {
    docker_workload_manifest=$(docker_workload_request list 'http://localhost/containers/json?all=0&limit=21&size=0&filters=%7B%22status%22%3A%5B%22running%22%5D%7D')
    docker_workload_result=$?
    [ "$docker_workload_result" = 0 ] || { docker_workload_manifest=; return "$docker_workload_result"; }
    [ -n "$docker_workload_manifest" ] || return 65
    printf '%s\n' "$docker_workload_manifest"
}

docker_workload_item() {
    # A failed/empty inventory never triggers speculative inspection requests.
    [ -n "${docker_workload_manifest:-}" ] || { printf 'unused\n'; return 0; }
    docker_workload_id=$(printf '%s' "$docker_workload_manifest" | jq -r --argjson slot "$1" '.ids[$slot] // empty') || return 65
    [ -n "$docker_workload_id" ] || { printf 'unused\n'; return 0; }
    case "$docker_workload_id" in *[!0-9a-f]*) return 65;; esac
    [ "${#docker_workload_id}" = 64 ] || return 65
    docker_workload_request item "http://localhost/containers/$docker_workload_id/json"
}

collect docker_workload_list docker_workload_list
collect docker_workload_00 docker_workload_item 0
collect docker_workload_01 docker_workload_item 1
collect docker_workload_02 docker_workload_item 2
collect docker_workload_03 docker_workload_item 3
collect docker_workload_04 docker_workload_item 4
collect docker_workload_05 docker_workload_item 5
collect docker_workload_06 docker_workload_item 6
collect docker_workload_07 docker_workload_item 7
collect docker_workload_08 docker_workload_item 8
collect docker_workload_09 docker_workload_item 9
collect docker_workload_10 docker_workload_item 10
collect docker_workload_11 docker_workload_item 11
collect docker_workload_12 docker_workload_item 12
collect docker_workload_13 docker_workload_item 13
collect docker_workload_14 docker_workload_item 14
collect docker_workload_15 docker_workload_item 15
collect docker_workload_16 docker_workload_item 16
collect docker_workload_17 docker_workload_item 17
collect docker_workload_18 docker_workload_item 18
collect docker_workload_19 docker_workload_item 19
