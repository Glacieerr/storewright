// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "StoreXTwinTypes.h"
#include "StoreXFleetActor.generated.h"

class UHierarchicalInstancedStaticMeshComponent;

/**
 * 车队演员：按孪生服务推来的车辆位置，用分层实例化静态网格体画所有的车（每种车型一个组件），
 * 两帧之间插值（位置线性、朝向球面插值），所以服务每 250 毫秒推一次，画面也是连续的。
 * 车型网格体在项目设置 → StoreX Twin → Kind Meshes 里配（键见 MeshKeyFor）。
 */
UCLASS()
class STOREXTWIN_API AStoreXFleetActor : public AActor
{
	GENERATED_BODY()

public:
	AStoreXFleetActor();
	virtual void Tick(float DeltaSeconds) override;

	/** 一辆车用哪个网格体：SM_SemiDry / SM_SemiReefer / SM_SemiPlain / SM_SemiPlainReefer / SM_EvTruck / SM_VanOnline / SM_VanBakery / SM_Drayage；火车、船、飞机用 train / ship / plane（自己配网格体） */
	UFUNCTION(BlueprintPure, Category = "StoreX")
	static FString MeshKeyFor(const FStoreXVehicle& Vehicle);

protected:
	UPROPERTY(EditAnywhere, Category = "StoreX")
	bool bInterpolate = true;

	UPROPERTY(VisibleInstanceOnly, Category = "StoreX")
	TMap<FString, TObjectPtr<UHierarchicalInstancedStaticMeshComponent>> Fleets;

private:
	UHierarchicalInstancedStaticMeshComponent* FleetFor(const FString& Key);
};
