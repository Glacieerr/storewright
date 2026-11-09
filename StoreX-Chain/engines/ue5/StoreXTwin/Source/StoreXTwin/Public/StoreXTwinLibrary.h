// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "StoreXTwinLibrary.generated.h"

/** 坐标换算：孪生服务的沙盘坐标（米，x 向东、z 向南）和虚幻坐标（厘米） */
UCLASS()
class STOREXTWIN_API UStoreXTwinLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** 沙盘 (x, z) → 关卡里的位置（按项目设置里的比例、原点、是否镜像） */
	UFUNCTION(BlueprintPure, Category = "StoreX")
	static FVector TwinToWorld(float X, float Z);

	/** 关卡里的位置 → 沙盘 (x, z) */
	UFUNCTION(BlueprintPure, Category = "StoreX")
	static FVector2D WorldToTwin(const FVector& World);

	/** 当天 0 点起的秒 → "07:35" */
	UFUNCTION(BlueprintPure, Category = "StoreX")
	static FString ClockText(float TwinSeconds);
};
