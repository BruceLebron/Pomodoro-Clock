package server

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// ParseAllowedHosts 只接受精确 DNS 名称或 IP；不允许 URL、端口、通配或空元素。
func ParseAllowedHosts(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	hosts := make([]string, 0)
	seen := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		host, err := configuredHostname(strings.TrimSpace(part))
		if err != nil {
			return nil, fmt.Errorf("invalid ALLOWED_HOSTS entry %q: %w", part, err)
		}
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		if !seen[host] {
			hosts = append(hosts, host)
			seen[host] = true
		}
	}
	return hosts, nil
}

func configuredHostname(raw string) (string, error) {
	// IPv6 配置须使用无端口的括号形式，避免与 host:port 语法混淆。
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		ip := net.ParseIP(raw[1 : len(raw)-1])
		if ip == nil || ip.To4() != nil {
			return "", fmt.Errorf("invalid IPv6 literal")
		}
		return strings.ToLower(raw[1 : len(raw)-1]), nil
	}
	if raw == "" || len(raw) > 253 || strings.ContainsAny(raw, ":/?#@*\\") {
		return "", fmt.Errorf("expected a hostname without URL, port or wildcard")
	}
	for _, label := range strings.Split(raw, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("invalid DNS label")
		}
		for _, char := range label {
			if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-') {
				return "", fmt.Errorf("invalid hostname character")
			}
		}
	}
	return strings.ToLower(raw), nil
}

func requestHostname(authority string) (string, bool) {
	host := authority
	if strings.Contains(authority, ":") && !(strings.HasPrefix(authority, "[") && strings.HasSuffix(authority, "]")) {
		var port string
		var err error
		host, port, err = net.SplitHostPort(authority)
		if err != nil || port == "" {
			return "", false
		}
		for _, digit := range port {
			if digit < '0' || digit > '9' {
				return "", false
			}
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", false
		}
		// SplitHostPort 去掉 IPv6 的括号，配置校验需要补回无端口括号。
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	parsed, err := configuredHostname(host)
	return parsed, err == nil
}

func (s *Server) allowedHost(authority string) bool {
	host, ok := requestHostname(authority)
	return ok && s.allowedHosts[host]
}
