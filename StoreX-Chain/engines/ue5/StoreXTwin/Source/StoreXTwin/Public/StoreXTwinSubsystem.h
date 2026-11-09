// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "StoreXTwinTypes.h"
#include "StoreXTwinSubsystem.generated.h"

class IWebSocket;
class FJsonObject;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FStoreXTickEvent, float, TwinSeconds, const TArray<FStoreXVehicle>&, Vehicles, const FStoreXKpi&, Kpi);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FStoreXCardsEvent, const TArray<FStoreXCard>&, Cards);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FStoreXJsonEvent, const FString&, Json);

/**
 * 孪生服务的客户端（游戏实例级）：连上 WebSocket，每一帧 tick 收车辆位置和累计指标，收现场数据和建议卡的变化；
 * 批准 / 否决建议、发指令、调速度也走同一条 WebSocket。车辆位置在这里换成虚幻坐标（厘米）。
 */
UCLASS()
class STOREXTWIN_API UStoreXTwinSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void Connect();

	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void Disconnect();

	UFUNCTION(BlueprintPure, Category = "StoreX")
	bool IsConnected() const;

	/** 批准一张待处理的建议卡；Option 为空就执行推荐的做法 */
	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void Approve(const FString& Key, const FString& Option);

	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void Reject(const FString& Key);

	/** 直接发一条指令给现场，例如 {"kind":"restock","fam":"DAIRY","units":2000} */
	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void SendCommandJson(const FString& CommandJson);

	/** 每秒走几分钟、暂停 */
	UFUNCTION(BlueprintCallable, Category = "StoreX")
	void SetSpeed(float MinutesPerSecond, bool bPaused);

	UPROPERTY(BlueprintAssignable, Category = "StoreX")
	FStoreXTickEvent OnTick;

	UPROPERTY(BlueprintAssignable, Category = "StoreX")
	FStoreXCardsEvent OnCards;

	/** 新的现场数据（原样的 JSON 数组，不含定位和收银） */
	UPROPERTY(BlueprintAssignable, Category = "StoreX")
	FStoreXJsonEvent OnMessages;

	/** 最近两帧的车辆（车队演员用来插值）和收到最近一帧的时刻 */
	const TArray<FStoreXVehicle>& GetVehicles() const { return Current; }
	const TArray<FStoreXVehicle>& GetPreviousVehicles() const { return Previous; }
	double GetLastTickSeconds() const { return LastTickSeconds; }

	UFUNCTION(BlueprintPure, Category = "StoreX")
	float GetTwinSeconds() const { return TwinSeconds; }

	UFUNCTION(BlueprintPure, Category = "StoreX")
	const TArray<FStoreXCard>& GetCards() const { return Cards; }

private:
	void HandleMessage(const FString& Text);
	void ReadVehicles(const TArray<TSharedPtr<class FJsonValue>>& List);
	void ReadCards(const TArray<TSharedPtr<class FJsonValue>>& List);
	void Send(const TSharedRef<FJsonObject>& Obj);

	TSharedPtr<IWebSocket> Socket;
	TArray<FStoreXVehicle> Current;
	TArray<FStoreXVehicle> Previous;
	TArray<FStoreXCard> Cards;
	FStoreXKpi Kpi;
	double LastTickSeconds = 0.0;
	float TwinSeconds = 0.f;
};
