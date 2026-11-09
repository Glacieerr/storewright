// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#include "StoreXFleetActor.h"

#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "StoreXTwinSettings.h"
#include "StoreXTwinSubsystem.h"

AStoreXFleetActor::AStoreXFleetActor()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

FString AStoreXFleetActor::MeshKeyFor(const FStoreXVehicle& V)
{
	// 长途车、供应商、区域生鲜集货、空运的车没有自己车队的彩条
	const bool bOutside = V.Label.Contains(TEXT("长途")) || V.Label.Contains(TEXT("供应商")) || V.Label.Contains(TEXT("生鲜集货")) || V.Label.Contains(TEXT("空运"));
	if (V.Kind == TEXT("truck")) return bOutside ? TEXT("SM_SemiPlain") : TEXT("SM_SemiDry");
	if (V.Kind == TEXT("reefer")) return bOutside ? TEXT("SM_SemiPlainReefer") : TEXT("SM_SemiReefer");
	if (V.Kind == TEXT("ev")) return TEXT("SM_EvTruck");
	if (V.Kind == TEXT("van")) return V.Label.Contains(TEXT("面包")) ? TEXT("SM_VanBakery") : TEXT("SM_VanOnline");
	if (V.Kind == TEXT("drayage")) return TEXT("SM_Drayage");
	return V.Kind;
}

UHierarchicalInstancedStaticMeshComponent* AStoreXFleetActor::FleetFor(const FString& Key)
{
	if (TObjectPtr<UHierarchicalInstancedStaticMeshComponent>* Found = Fleets.Find(Key))
	{
		return Found->Get();
	}
	const TSoftObjectPtr<UStaticMesh>* MeshPtr = GetDefault<UStoreXTwinSettings>()->KindMeshes.Find(Key);
	UStaticMesh* Mesh = MeshPtr ? MeshPtr->LoadSynchronous() : nullptr;
	if (!Mesh)
	{
		Fleets.Add(Key, nullptr);
		return nullptr;
	}
	UHierarchicalInstancedStaticMeshComponent* C = NewObject<UHierarchicalInstancedStaticMeshComponent>(this, *FString::Printf(TEXT("Fleet_%s"), *Key));
	C->SetStaticMesh(Mesh);
	C->SetMobility(EComponentMobility::Movable);
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetupAttachment(RootComponent);
	C->RegisterComponent();
	Fleets.Add(Key, C);
	return C;
}

void AStoreXFleetActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const UGameInstance* GI = GetGameInstance();
	UStoreXTwinSubsystem* Twin = GI ? GI->GetSubsystem<UStoreXTwinSubsystem>() : nullptr;
	if (!Twin)
	{
		return;
	}
	const TArray<FStoreXVehicle>& Now = Twin->GetVehicles();
	const TArray<FStoreXVehicle>& Before = Twin->GetPreviousVehicles();
	TMap<int32, const FStoreXVehicle*> Prev;
	for (const FStoreXVehicle& V : Before)
	{
		Prev.Add(V.Vid, &V);
	}
	const float Window = GetDefault<UStoreXTwinSettings>()->InterpolationSeconds;
	const float Alpha = bInterpolate ? FMath::Clamp(static_cast<float>((FPlatformTime::Seconds() - Twin->GetLastTickSeconds()) / Window), 0.f, 1.f) : 1.f;

	TMap<FString, TArray<FTransform>> ByKey;
	for (const FStoreXVehicle& V : Now)
	{
		FVector Loc = V.Location;
		FQuat Rot = FRotator(0.f, V.Yaw, 0.f).Quaternion();
		if (const FStoreXVehicle* const* P = Prev.Find(V.Vid))
		{
			Loc = FMath::Lerp((*P)->Location, V.Location, Alpha);
			Rot = FQuat::Slerp(FRotator(0.f, (*P)->Yaw, 0.f).Quaternion(), Rot, Alpha);
		}
		ByKey.FindOrAdd(MeshKeyFor(V)).Add(FTransform(Rot, Loc));
	}
	// 每种车型：数量变了就重建实例，没变就批量更新位置
	for (TPair<FString, TObjectPtr<UHierarchicalInstancedStaticMeshComponent>>& F : Fleets)
	{
		if (F.Value && !ByKey.Contains(F.Key) && F.Value->GetInstanceCount() > 0)
		{
			F.Value->ClearInstances();
		}
	}
	for (TPair<FString, TArray<FTransform>>& K : ByKey)
	{
		UHierarchicalInstancedStaticMeshComponent* C = FleetFor(K.Key);
		if (!C)
		{
			continue;
		}
		if (C->GetInstanceCount() != K.Value.Num())
		{
			C->ClearInstances();
			C->AddInstances(K.Value, false, true);
		}
		else
		{
			C->BatchUpdateInstancesTransforms(0, K.Value, true, true, true);
		}
	}
}
