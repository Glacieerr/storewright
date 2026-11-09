// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
// 孪生服务客户端模块：WebSocket 收车辆位置和建议，REST / WebSocket 发决定和指令
using UnrealBuildTool;

public class StoreXTwin : ModuleRules
{
	public StoreXTwin(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "DeveloperSettings" });
		PrivateDependencyModuleNames.AddRange(new string[] { "WebSockets", "Json", "JsonUtilities" });
	}
}
