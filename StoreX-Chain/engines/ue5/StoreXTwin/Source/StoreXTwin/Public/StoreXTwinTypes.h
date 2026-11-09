// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "StoreXTwinTypes.generated.h"

/** 一辆车此刻的状态（孪生服务的 tick 消息；坐标已经换成虚幻的厘米） */
USTRUCT(BlueprintType)
struct STOREXTWIN_API FStoreXVehicle
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "StoreX") int32 Vid = 0;
	/** 作业编号（M03、DS-BEV-1、IN-AMB_C-1…）或车名 */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Id;
	/** truck / reefer / ev / van / drayage / train / ship / plane */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Kind;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Label;
	/** 车头（前保险杠中间、地面）的位置，厘米 */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FVector Location = FVector::ZeroVector;
	/** 车头朝向（度），虚幻的 Yaw */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Yaw = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") bool bReversing = false;
	/** 比计划晚了多少分钟 */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float DelayMin = 0.f;
	/** 冷机车的货温（°C） */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") bool bHasTemp = false;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Temp = 0.f;
	/** 抛锚、等救援车、等月台门、等收货口、按指令晚点到（空 = 正常） */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString State;
	/** 这一段在做什么（计划里的说明） */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Act;
};

/** 建议卡上的一个做法和孪生推演的结果 */
USTRUCT(BlueprintType)
struct STOREXTWIN_API FStoreXOption
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Key;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Label;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Late = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Hot = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Short = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Cost = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Note;
	/** 低风险（「低风险的自动执行」时自动执行） */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") bool bAuto = false;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") bool bHasCommands = false;
};

/** 孪生的一张建议卡 */
USTRUCT(BlueprintType)
struct STOREXTWIN_API FStoreXCard
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Key;
	/** late / temp / breakdown / door / stockout */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Kind;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Time = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Clock;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Title;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Text;
	/** proposed / done / rejected / resolved / expired */
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Status;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Best;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") FString Chosen;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") TArray<FStoreXOption> Options;
};

/** 现场到此刻的累计结果 */
USTRUCT(BlueprintType)
struct STOREXTWIN_API FStoreXKpi
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float LateMin = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float HotMin = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float ShortMin = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float DoorWaitMin = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float DockWaitMin = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "StoreX") float Cost = 0.f;
};
