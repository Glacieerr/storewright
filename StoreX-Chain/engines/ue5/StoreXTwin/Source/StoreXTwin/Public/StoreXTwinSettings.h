// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "StoreXTwinSettings.generated.h"

class UStaticMesh;

/** 项目设置 → 插件 → StoreX Twin */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "StoreX Twin"))
class STOREXTWIN_API UStoreXTwinSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	/** 孪生服务的 WebSocket 地址（server/protocol.md） */
	UPROPERTY(Config, EditAnywhere, Category = "Server")
	FString ServerUrl = TEXT("ws://127.0.0.1:8787/ws");

	/** 开始游戏时自动连接 */
	UPROPERTY(Config, EditAnywhere, Category = "Server")
	bool bAutoConnect = true;

	/** 沙盘米 → 虚幻厘米 */
	UPROPERTY(Config, EditAnywhere, Category = "Coordinates")
	float Scale = 100.f;

	/** 区域原点在关卡里的位置（导入的区域模型挪过的话，这里一起挪） */
	UPROPERTY(Config, EditAnywhere, Category = "Coordinates")
	FVector Origin = FVector::ZeroVector;

	/** glTF 导入器的坐标约定和这里不一致时（区域模型南北反了）打开：Y 取反、朝向取反 */
	UPROPERTY(Config, EditAnywhere, Category = "Coordinates")
	bool bMirrorY = false;

	/** 车型网格体：键是网格体名（SM_SemiReefer 等，见 MeshKeyFor），值是 vehicles_ue.glb 导入后的静态网格体 */
	UPROPERTY(Config, EditAnywhere, Category = "Vehicles")
	TMap<FString, TSoftObjectPtr<UStaticMesh>> KindMeshes;

	/** 两帧之间插值的时长（秒），和孪生服务推送的间隔差不多 */
	UPROPERTY(Config, EditAnywhere, Category = "Vehicles", meta = (ClampMin = "0.01"))
	float InterpolationSeconds = 0.25f;
};
